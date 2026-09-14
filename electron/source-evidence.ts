import { DomainValidationError } from './node-validation.js';
import { createHash } from 'node:crypto';
import type { RequirementDetail, SourceRef, SourceUnit } from '../src/types.js';

export interface SourceEvidence {
  id: string;
  sourceUnitId: string;
  start: number;
  end: number;
  text: string;
}

export interface DetailEvidenceIssue {
  code: 'required'|'type'|'empty'|'unknown-field'|'unknown-evidence'|'duplicate';
  path: string;
  expected: string;
  actual: string;
}

export class DetailEvidenceValidationError extends Error {
  constructor(readonly issues:DetailEvidenceIssue[]) {
    super(issues.map(issue=>`${issue.path}：需要${issue.expected}，实际${issue.actual}`).join('\n'));
    this.name='DetailEvidenceValidationError';
  }
}

const sourceText = (unit: SourceUnit) => unit.asset?.extractedText ?? unit.excerpt;

function boundaries(text: string) {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!/[。！？；\n]/u.test(text[index])) continue;
    const end = index + 1;
    if (text.slice(start, end).trim()) { ranges.push([start, end]); start = end; }
  }
  if (text.slice(start).trim()) ranges.push([start, text.length]);
  else if (ranges.length) ranges[ranges.length - 1][1] = text.length;
  return ranges;
}

/** 证据位置完全由冻结来源生成；模型只选择 id，不复制文字或计算偏移。 */
export function buildEvidenceCatalog(units: SourceUnit[]): SourceEvidence[] {
  const result: SourceEvidence[] = [];
  for (const unit of units) {
    const text = sourceText(unit);
    if (!text.length) continue;
    // 同一文字只发送一次。多句来源按不重叠句段提供，避免“整段 + 分句”重复放大提示词。
    const sentenceRanges=boundaries(text);
    const ranges: Array<[number, number]> = sentenceRanges.length ? sentenceRanges : [[0,text.length]];
    const seen = new Set<string>();
    for (const [start, end] of ranges) {
      const key = `${start}:${end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const digest = createHash('sha256').update(`${unit.id}\0${start}\0${end}`).digest('hex').slice(0, 12);
      result.push({ id: `E-${digest}`, sourceUnitId: unit.id, start, end, text: text.slice(start, end) });
    }
  }
  return result;
}

export function resolveEvidenceIds(ids: unknown, catalog: SourceEvidence[], path: string): SourceRef[] {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id.trim())) throw new DomainValidationError(`${path} 必须是非空证据编号数组`);
  const byId = new Map(catalog.map(item => [item.id, item]));
  return ids.map((raw, index) => {
    const evidence = byId.get(raw as string);
    if (!evidence) throw new DomainValidationError(`${path}[${index}] 引用了未提供或过期的证据编号：${String(raw)}`);
    return { sourceUnitId: evidence.sourceUnitId, start: evidence.start, end: evidence.end };
  });
}

export function materializeEvidenceSelections(value: Record<string, unknown>, catalog: SourceEvidence[]) {
  const visit = (current: unknown, path: string): unknown => {
    if (Array.isArray(current)) return current.map((item, index) => visit(item, `${path}[${index}]`));
    if (!current || typeof current !== 'object') return current;
    const item = { ...(current as Record<string, unknown>) };
    // 生成候选的初始状态属于平台，不要求模型提交内部生命周期字段。
    if(typeof item.question==='string'&&typeof item.level==='string'&&Object.prototype.hasOwnProperty.call(item,'evidenceIds'))item.state='open';
    if(Array.isArray(item.features))item.features=item.features.map(raw=>raw&&typeof raw==='object'?{...raw,state:'draft'}:raw);
    if (catalog.length && Array.isArray(item.sourceRefs) && item.sourceRefs.some(raw => raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'quote'))) throw new DomainValidationError(`${path}.sourceRefs 不得包含模型抄写的 quote，请选择 evidenceIds`);
    if (Object.prototype.hasOwnProperty.call(item, 'evidenceIds')) {
      item.sourceRefs = resolveEvidenceIds(item.evidenceIds, catalog, `${path}.evidenceIds`);
      delete item.evidenceIds;
    }
    if (Object.prototype.hasOwnProperty.call(item, 'allocations')) {
      if (!Array.isArray(item.allocations) || !item.allocations.length) throw new DomainValidationError(`${path}.allocations 必须为非空证据分配数组`);
      if (item.sourceRefsByFeature !== undefined) throw new DomainValidationError(`${path} 不得混用证据分配协议`);
      const seen = new Set<string>();
      item.sourceRefsByFeature = Object.fromEntries(item.allocations.map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DomainValidationError(`${path}.allocations[${index}] 必须是对象`);
        const allocation = raw as Record<string, unknown>, id = allocation.featureId;
        if (typeof id !== 'string' || !id.trim() || seen.has(id)) throw new DomainValidationError(`${path}.allocations[${index}].featureId 无效或重复`);
        seen.add(id);
        return [id, resolveEvidenceIds(allocation.evidenceIds, catalog, `${path}.allocations[${index}].evidenceIds`)];
      }));
      delete item.allocations;
    }
    for (const [key, child] of Object.entries(item)) item[key] = visit(child, `${path}.${key}`);
    return item;
  };
  return visit(value, 'response') as Record<string, unknown>;
}

/** 正式条目只物化短文本和条目级原文引用；完整问题与建议仍使用原协议。 */
export function materializeDetailEvidenceSelections(value:Record<string,unknown>,catalog:SourceEvidence[],featureId?:string):Record<string,unknown> {
  if(!Array.isArray(value.requirements))throw new DomainValidationError('requirements 必须为数组');
  const requirements=value.requirements.map((raw,index)=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new DomainValidationError('需求项必须为对象');
    const item=raw as Record<string,unknown>,allowed=new Set(['id','text','evidenceIds','featureId']);
    if(Object.keys(item).some(key=>!allowed.has(key)))throw new DomainValidationError('需求项包含旧规格书或内部字段');
    const id=typeof item.id==='string'?item.id.trim():'',text=typeof item.text==='string'?item.text.trim():'',owner=item.featureId??featureId;
    if(!id||!text||typeof owner!=='string'||!owner.trim())throw new DomainValidationError(`requirements[${index}] 缺少编号、短文本或所属功能`);
    if(featureId&&item.featureId!==undefined&&item.featureId!==featureId)throw new DomainValidationError('需求所属功能越界');
    return {id,text,featureId:owner,sourceRefs:resolveEvidenceIds(item.evidenceIds,catalog,`requirements[${index}].evidenceIds`),state:'draft'} satisfies RequirementDetail;
  });
  return materializeEvidenceSelections({...value,requirements},catalog);
}

export function evidencePromptInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { input, catalog: [] as SourceEvidence[] };
  const result = structuredClone(input) as Record<string, unknown>;
  const units = Array.isArray(result.sourceUnits) ? result.sourceUnits as SourceUnit[] : [];
  const allowedRefs=Array.isArray(result.evidenceSourceRefs)?result.evidenceSourceRefs as SourceRef[]:undefined;
  const candidateRefs=Array.isArray(result.candidateEvidenceRefs)?result.candidateEvidenceRefs as Array<{candidateId:string;refs:SourceRef[]}>:undefined;
  delete result.evidenceSourceRefs;
  delete result.candidateEvidenceRefs;
  const selectedRefs=[...(allowedRefs??[]),...(candidateRefs?.flatMap(item=>item.refs)??[]),...(Array.isArray(result.currentRequirements)?(result.currentRequirements as RequirementDetail[]).flatMap(item=>item.sourceRefs):[])];
  const catalog = buildEvidenceCatalog(units).flatMap(item=>{
    const boundaries=[item.start,item.end,...selectedRefs.filter(ref=>ref.sourceUnitId===item.sourceUnitId).flatMap(ref=>[ref.start,ref.end]).filter((position):position is number=>Number.isInteger(position)&&position!>item.start&&position!<item.end)];
    const points=[...new Set(boundaries)].sort((a,b)=>a-b);
    return points.slice(0,-1).map((start,index)=>({...item,start,end:points[index+1],text:item.text.slice(start-item.start,points[index+1]-item.start)}));
  }).filter(item=>!allowedRefs||allowedRefs.some(ref=>ref.sourceUnitId===item.sourceUnitId&&item.start>=(ref.start??0)&&item.end<=(ref.end??Number.MAX_SAFE_INTEGER))).map((item,index)=>({...item,id:`E${index+1}`}));
  if (catalog.length) {
    if(Array.isArray(result.currentRequirements))result.currentRequirements=(result.currentRequirements as RequirementDetail[]).map(requirement=>({
      id:requirement.id,text:requirement.text,featureId:requirement.featureId,
      evidenceIds:catalog.filter(evidence=>requirement.sourceRefs.some(ref=>ref.sourceUnitId===evidence.sourceUnitId&&evidence.start>=(ref.start??0)&&evidence.end<=(ref.end??Number.MAX_SAFE_INTEGER))).map(evidence=>evidence.id),
    }));
    result.sourceUnits = units.map(unit => ({id:unit.id,label:unit.label,kind:unit.kind,location:unit.location,...(unit.logicalPath?{logicalPath:unit.logicalPath}:{}),...(unit.sourceRole?{sourceRole:unit.sourceRole}:{}),...(unit.context?{context:unit.context}:{}),...(unit.asset?{asset:{mimeType:unit.asset.mimeType,readStatus:unit.asset.readStatus}}:{})}));
    result.evidenceCatalog = candidateRefs?catalog.map(evidence=>({...evidence,candidateIds:candidateRefs.filter(item=>item.refs.some(ref=>ref.sourceUnitId===evidence.sourceUnitId&&evidence.start>=(ref.start??0)&&evidence.end<=(ref.end??Number.MAX_SAFE_INTEGER))).map(item=>item.candidateId)})):catalog;
  }
  return { input: result, catalog };
}
