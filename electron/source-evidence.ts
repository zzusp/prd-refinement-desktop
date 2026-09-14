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
    if (Object.prototype.hasOwnProperty.call(item, 'explicitAcceptanceEvidenceIds')) {
      if (!Array.isArray(item.explicitAcceptanceEvidenceIds)) throw new DomainValidationError(`${path}.explicitAcceptanceEvidenceIds 必须是证据编号数组`);
      const selected = item.explicitAcceptanceEvidenceIds.length ? resolveEvidenceIds(item.explicitAcceptanceEvidenceIds, catalog, `${path}.explicitAcceptanceEvidenceIds`) : [];
      const byUnit = new Map(catalog.map(evidence => [evidence.id, evidence]));
      const ids = item.explicitAcceptanceEvidenceIds as string[];
      item.explicitAcceptanceConditions = ids.map(id => byUnit.get(id)!.text);
      const bindings = item.evidenceBindings && typeof item.evidenceBindings === 'object' && !Array.isArray(item.evidenceBindings) ? { ...(item.evidenceBindings as Record<string, unknown>) } : {};
      bindings.explicitAcceptanceConditions = selected.map(ref => [ref]);
      item.evidenceBindings = bindings;
      delete item.explicitAcceptanceEvidenceIds;
    }
    if (item.evidenceBindings && typeof item.evidenceBindings === 'object' && !Array.isArray(item.evidenceBindings)) {
      const bindings = { ...(item.evidenceBindings as Record<string, unknown>) };
      for (const key of ['behavior', 'conditions', 'constraints', 'explicitAcceptanceConditions']) {
        const raw = bindings[key];
        if (!Array.isArray(raw)) continue;
        if (key === 'behavior') {
          if (raw.every(value => typeof value === 'string')) bindings[key] = resolveEvidenceIds(raw, catalog, `${path}.evidenceBindings.${key}`);
        } else bindings[key] = raw.map((ids, index) => Array.isArray(ids) && ids.every(value => typeof value === 'string') ? resolveEvidenceIds(ids, catalog, `${path}.evidenceBindings.${key}[${index}]`) : ids);
      }
      item.evidenceBindings = bindings;
      const collect = (value: unknown): SourceRef[] => Array.isArray(value) ? value.flatMap(collect) : value && typeof value === 'object' && typeof (value as SourceRef).sourceUnitId === 'string' ? [value as SourceRef] : [];
      const selected = Object.values(bindings).flatMap(collect);
      if (selected.length) item.sourceUnitIds = [...new Set(selected.map(ref => ref.sourceUnitId))];
    }
    for (const [key, child] of Object.entries(item)) item[key] = visit(child, `${path}.${key}`);
    return item;
  };
  return visit(value, 'response') as Record<string, unknown>;
}

/** 细化节点只返回内容与证据对；来源、绑定和初始状态由程序确定性生成。 */
export function materializeDetailEvidenceSelections(value:Record<string,unknown>,catalog:SourceEvidence[]):Record<string,unknown> {
  const issues:DetailEvidenceIssue[]=[],byId=new Map(catalog.map(item=>[item.id,item]));
  const actual=(value:unknown)=>Array.isArray(value)?`数组(${value.length})`:value===null?'null':typeof value;
  const requiredText=(value:unknown,path:string)=>{if(typeof value!=='string'){issues.push({code:'type',path,expected:'非空文本',actual:actual(value)});return''}if(!value.trim()){issues.push({code:'empty',path,expected:'非空文本',actual:'空文本'});return''}return value.trim()};
  const evidenceIds=(value:unknown,path:string,allowEmpty=false)=>{
    if(!Array.isArray(value)){issues.push({code:'type',path,expected:allowEmpty?'证据编号数组':'非空证据编号数组',actual:actual(value)});return[] as string[]}
    if(!allowEmpty&&!value.length)issues.push({code:'empty',path,expected:'非空证据编号数组',actual:'空数组'});
    const ids:string[]=[];for(const [index,item] of value.entries()){if(typeof item!=='string'||!item.trim()){issues.push({code:'type',path:`${path}[${index}]`,expected:'非空证据编号',actual:actual(item)});continue}const id=item.trim();if(!byId.has(id))issues.push({code:'unknown-evidence',path:`${path}[${index}]`,expected:'本批 evidenceCatalog 中的证据编号',actual:id});ids.push(id)}
    if(new Set(ids).size!==ids.length)issues.push({code:'duplicate',path,expected:'不重复的证据编号',actual:'包含重复项'});return ids;
  };
  const record=(raw:unknown,path:string)=>{if(!raw||typeof raw!=='object'||Array.isArray(raw)){issues.push({code:'type',path,expected:'对象',actual:actual(raw)});return undefined}return raw as Record<string,unknown>};
  const paired=(raw:unknown,path:string)=>{const item=record(raw,path);if(!item)return{text:'',ids:[] as string[]};const unknown=Object.keys(item).filter(key=>!['text','evidenceIds'].includes(key));for(const key of unknown)issues.push({code:'unknown-field',path:`${path}.${key}`,expected:'仅 text、evidenceIds',actual:'未知字段'});return{text:requiredText(item.text,`${path}.text`),ids:evidenceIds(item.evidenceIds,`${path}.evidenceIds`)};};
  const pairedList=(raw:unknown,path:string)=>{if(!Array.isArray(raw)){issues.push({code:'type',path,expected:'内容与证据对象数组',actual:actual(raw)});return[] as Array<{text:string;ids:string[]}>}return raw.map((item,index)=>paired(item,`${path}[${index}]`));};
  if(!Array.isArray(value.requirements))issues.push({code:'type',path:'requirements',expected:'需求对象数组',actual:actual(value.requirements)});
  const seen=new Set<string>();const requirements=(Array.isArray(value.requirements)?value.requirements:[]).map((raw,index)=>{
    const path=`requirements[${index}]`,item=record(raw,path);if(!item)return undefined;
    const allowed=new Set(['id','title','behavior','conditions','constraints','explicitAcceptanceEvidenceIds','featureId']);
    for(const key of Object.keys(item).filter(key=>!allowed.has(key)))issues.push({code:'unknown-field',path:`${path}.${key}`,expected:'当前细化输出字段',actual:'未知或程序生成字段'});
    const id=requiredText(item.id,`${path}.id`),title=requiredText(item.title,`${path}.title`);if(id){if(seen.has(id))issues.push({code:'duplicate',path:`${path}.id`,expected:'唯一需求 ID',actual:id});seen.add(id)}
    const behavior=paired(item.behavior,`${path}.behavior`),conditions=pairedList(item.conditions,`${path}.conditions`),constraints=pairedList(item.constraints,`${path}.constraints`),acceptanceIds=evidenceIds(item.explicitAcceptanceEvidenceIds,`${path}.explicitAcceptanceEvidenceIds`,true);
    const featureId=item.featureId===undefined?undefined:requiredText(item.featureId,`${path}.featureId`),refs=(ids:string[])=>ids.flatMap(id=>{const evidence=byId.get(id);return evidence?[{sourceUnitId:evidence.sourceUnitId,start:evidence.start,end:evidence.end}]:[]});
    const behaviorRefs=refs(behavior.ids),conditionRefs=conditions.map(entry=>refs(entry.ids)),constraintRefs=constraints.map(entry=>refs(entry.ids)),acceptanceRefs=refs(acceptanceIds),allRefs=[...behaviorRefs,...conditionRefs.flat(),...constraintRefs.flat(),...acceptanceRefs];
    return{id,title,behavior:behavior.text,conditions:conditions.map(entry=>entry.text),constraints:constraints.map(entry=>entry.text),explicitAcceptanceConditions:acceptanceIds.map(id=>byId.get(id)?.text??''),sourceUnitIds:[...new Set(allRefs.map(ref=>ref.sourceUnitId))],ruleIds:[],state:'draft',evidenceBindings:{behavior:behaviorRefs,conditions:conditionRefs,constraints:constraintRefs,explicitAcceptanceConditions:acceptanceRefs.map(ref=>[ref])},...(featureId?{featureId}:{})} satisfies RequirementDetail&{featureId?:string};
  }).filter((item):item is NonNullable<typeof item>=>!!item);
  if(issues.length)throw new DetailEvidenceValidationError(issues);
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
  const catalog = buildEvidenceCatalog(units).filter(item=>!allowedRefs||allowedRefs.some(ref=>ref.sourceUnitId===item.sourceUnitId&&item.start>=(ref.start??0)&&item.end<=(ref.end??Number.MAX_SAFE_INTEGER))).map((item,index)=>({...item,id:`E${index+1}`}));
  if (catalog.length) {
    if(Array.isArray(result.currentRequirements))result.currentRequirements=(result.currentRequirements as Array<RequirementDetail&{featureId?:string}>).map(requirement=>{
      const ids=(refs:SourceRef[]|undefined)=>catalog.filter(evidence=>(refs??[]).some(ref=>ref.sourceUnitId===evidence.sourceUnitId&&evidence.start>=(ref.start??0)&&evidence.end<=(ref.end??Number.MAX_SAFE_INTEGER))).map(evidence=>evidence.id);
      return{id:requirement.id,title:requirement.title,behavior:{text:requirement.behavior,evidenceIds:ids(requirement.evidenceBindings?.behavior)},conditions:requirement.conditions.map((text,index)=>({text,evidenceIds:ids(requirement.evidenceBindings?.conditions[index])})),constraints:requirement.constraints.map((text,index)=>({text,evidenceIds:ids(requirement.evidenceBindings?.constraints[index])})),explicitAcceptanceEvidenceIds:ids(requirement.evidenceBindings?.explicitAcceptanceConditions.flat()),...(requirement.featureId?{featureId:requirement.featureId}:{})};
    });
    result.sourceUnits = units.map(unit => ({id:unit.id,label:unit.label,kind:unit.kind,location:unit.location,...(unit.logicalPath?{logicalPath:unit.logicalPath}:{}),...(unit.sourceRole?{sourceRole:unit.sourceRole}:{}),...(unit.context?{context:unit.context}:{}),...(unit.asset?{asset:{mimeType:unit.asset.mimeType,readStatus:unit.asset.readStatus}}:{})}));
    result.evidenceCatalog = candidateRefs?catalog.map(evidence=>({...evidence,candidateIds:candidateRefs.filter(item=>item.refs.some(ref=>ref.sourceUnitId===evidence.sourceUnitId&&evidence.start>=(ref.start??0)&&evidence.end<=(ref.end??Number.MAX_SAFE_INTEGER))).map(item=>item.candidateId)})):catalog;
  }
  return { input: result, catalog };
}
