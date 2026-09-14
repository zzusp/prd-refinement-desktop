import { DomainValidationError } from './node-validation.js';
import type { AuditCategory, AuditIssue, Clarification, PrdProject, RequirementDetail, RequirementRule } from '../src/types.js';
import { acceptDirectDetails, validateDirectGraph } from './domain.js';

export const auditCategories = new Set<AuditCategory>(['rule-extraction','feature-boundary','detail-mismatch','unclassified']);

/** 只合并内容和引用均相同的问题，避免把相似但不同的条件吞掉。 */
export function classifyIssues(issues:AuditIssue[], project:PrdProject):AuditIssue[] {
  const details=new Set(project.requirements.map(item=>item.id));
  const rules=new Set((project.rules??[]).map(item=>item.id));
  const features=new Set(project.features.map(item=>item.id));
  const seen=new Set<string>();
  return issues.flatMap(issue=>{
    const key=JSON.stringify([issue.direction,issue.type,issue.detail,[...issue.sourceUnitIds].sort(),[...issue.affectedIds].sort()]);
    if(seen.has(key))return[];seen.add(key);
    let category=issue.owner==='feature-grouping'?'feature-boundary':issue.category;
    // Existing-rule errors must identify that rule. A true omission can have no rule ID yet.
    if(category==='rule-extraction'&&!issue.affectedIds.some(id=>rules.has(id))&&!/(遗漏|缺失|未提取)/.test(`${issue.type}${issue.detail}`))category=undefined;
    if(!category){
      if(issue.affectedIds.some(id=>features.has(id)))category='feature-boundary';
      else if(issue.affectedIds.length>0&&issue.affectedIds.every(id=>details.has(id)))category='detail-mismatch';
      else if(issue.affectedIds.some(id=>rules.has(id)))category='rule-extraction';
      else category='unclassified';
    }
    const requirementIds=issue.affectedIds.filter(id=>details.has(id));
    const ownershipIssue=/(?:requirement[-_ ]?ownership|需求归属)/i.test(issue.type)||/主所属功能/.test(issue.detail);
    let owner=issue.owner??(category==='feature-boundary'?'feature-grouping':category==='detail-mismatch'?'requirement-detail':'runtime-output');
    if(requirementIds.length){
      if(ownershipIssue){category='feature-boundary';owner='feature-grouping'}
      else if(category==='detail-mismatch'&&(owner!=='requirement-relation'||/(?:attribution|归属)/i.test(issue.type)))owner='requirement-detail';
    }
    return[{...issue,category,owner,disposition:issue.disposition??'open'}];
  });
}

export interface RepairScope { key:string; issues:AuditIssue[]; featureIds:string[]; requirementIds:string[]; clarificationIds:string[]; sourceUnitIds:string[]; requiredSourceUnitIds:string[]; readOnlyRequirementIds?:string[] }
export interface RequirementPatch {
  requirements:Array<RequirementDetail & { featureId:string }>;
  deleteRequirementIds:string[];
  clarifications:Clarification[];
  deleteClarificationIds:string[];
}
const distinct=(values:string[])=>[...new Set(values)];

/** 写集合决定并行边界，共享原文或功能本身不构成写冲突。 */
export function planDetailRepairs(issues:AuditIssue[],project:PrdProject):RepairScope[] {
  const scopes:RepairScope[]=[];
  const requirementById=new Map(project.requirements.map(item=>[item.id,item]));
  for(const issue of issues.filter(item=>(item.owner==='requirement-detail'||(item.owner===undefined&&item.category==='detail-mismatch'))&&item.disposition==='open')){
    const requirements=issue.affectedIds.filter(id=>requirementById.has(id));
    let features=project.features.filter(feature=>issue.affectedIds.includes(feature.id)||requirements.some(id=>feature.requirementIds.includes(id)));
    if(!features.length){
      const evidence=distinct(issue.sourceUnitIds);
      const candidates=project.features.filter(feature=>feature.sourceUnitIds.some(id=>evidence.includes(id)));
      if(candidates.length!==1)continue;
      features=candidates;
    }
    // 功能 ID 只用于定位归属，不能授权改写整个功能；来源遗漏允许定点新增需求。
    const sourceIds=new Set(project.sourceUnits.map(unit=>unit.id));
    const evidence=distinct([...issue.sourceUnitIds,...requirements.flatMap(id=>requirementById.get(id)!.sourceRefs.map(ref=>ref.sourceUnitId))]).filter(id=>sourceIds.has(id));
    const scope:RepairScope={key:issue.id,issues:[issue],featureIds:features.map(feature=>feature.id),requirementIds:requirements,clarificationIds:[],sourceUnitIds:evidence,requiredSourceUnitIds:distinct(issue.sourceUnitIds)};
    let merged=true;
    while(merged){merged=false;for(let index=scopes.length-1;index>=0;index--){const other=scopes[index];const sharedWrite=other.requirementIds.some(id=>scope.requirementIds.includes(id))||other.clarificationIds.some(id=>scope.clarificationIds.includes(id));const sameSources=other.sourceUnitIds.length===scope.sourceUnitIds.length&&other.sourceUnitIds.every(id=>scope.sourceUnitIds.includes(id));const sameMissingTarget=!other.requirementIds.length&&!scope.requirementIds.length&&!other.clarificationIds.length&&!scope.clarificationIds.length&&sameSources&&other.featureIds.some(id=>scope.featureIds.includes(id));if(!sharedWrite&&!sameMissingTarget)continue;
      scope.issues.push(...other.issues);for(const field of ['featureIds','requirementIds','clarificationIds','sourceUnitIds','requiredSourceUnitIds'] as const)scope[field]=distinct([...scope[field],...other[field]]);scopes.splice(index,1);merged=true;
    }}
    scope.key=scope.issues.map(item=>item.id).sort().join('+');scopes.push(scope);
  }
  return scopes.map(scope=>({...scope,readOnlyRequirementIds:distinct([
    ...project.features.filter(feature=>scope.featureIds.includes(feature.id)).flatMap(feature=>feature.requirementIds),
  ].filter(id=>!scope.requirementIds.includes(id)))}));
}

function stringList(value:unknown,label:string):string[]{if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!item.trim()))throw new DomainValidationError(`${label} 必须为字符串数组`);if(new Set(value).size!==value.length)throw new DomainValidationError(`${label} 含重复项`);return value as string[]}
function requiredText(value:unknown,label:string):string{if(typeof value!=='string'||!value.trim())throw new DomainValidationError(`${label} 必须为非空字符串`);return value}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new DomainValidationError('增量项必须为对象');return value as Record<string,unknown>}

export function acceptRequirementPatch(value:unknown,project:PrdProject,scope:RepairScope):RequirementPatch {
  const raw=record(value);
  if(Object.keys(raw).some(key=>!['requirements','deleteRequirementIds','clarifications','deleteClarificationIds'].includes(key)))throw new DomainValidationError('增量包含未知字段');
  if(!Array.isArray(raw.requirements))throw new DomainValidationError('增量必须包含 requirements 数组');
  if(!Array.isArray(raw.clarifications)||raw.clarifications.length||!Array.isArray(raw.deleteClarificationIds)||raw.deleteClarificationIds.length)throw new DomainValidationError('增量不允许生成或修改待处理事项');
  const sourceUnits=project.sourceUnits.filter(unit=>scope.sourceUnitIds.includes(unit.id));
  const rawRequirements=raw.requirements.map(value=>{const item=record(value),owners=project.features.filter(feature=>feature.requirementIds.includes(String(item.id)));return {...item,featureId:item.featureId??(owners.length===1?owners[0].id:scope.featureIds.length===1?scope.featureIds[0]:'')};});
  const accepted=acceptDirectDetails(rawRequirements,[],sourceUnits,true).requirements;
  const existing=new Set([...project.requirements,...project.clarifications,...project.features,...project.sourceUnits].map(item=>item.id));
  const checkId=(id:string,allowed:string[])=>{if(existing.has(id)){if(!allowed.includes(id))throw new DomainValidationError(`越界修改 ${id}`)}else if(!/^LOCAL-[A-Za-z0-9_-]+$/.test(id))throw new DomainValidationError(`新增项 ${id} 必须使用 LOCAL- ID`)};
  const requirements=accepted.map((item,index)=>{
    checkId(item.id,scope.requirementIds);
    const content=(entry:RequirementDetail)=>JSON.stringify([entry.text,entry.sourceRefs,entry.state]);
    if(!existing.has(item.id)&&project.requirements.some(other=>!scope.requirementIds.includes(other.id)&&content(other)===content(item)))throw new DomainValidationError(`${item.id} 复制了范围外需求`);
    const owners=project.features.filter(feature=>feature.requirementIds.includes(item.id));
    const requested=record(rawRequirements[index]).featureId;
    const featureId=requested===undefined?(owners.length===1?owners[0].id:scope.featureIds.length===1?scope.featureIds[0]:''):requiredText(requested,'featureId');
    if(!scope.featureIds.includes(featureId))throw new DomainValidationError(`${item.id} 必须指定范围内主功能`);
    if(existing.has(item.id)&&(owners.length!==1||owners[0].id!==featureId))throw new DomainValidationError(`${item.id} 不允许通过明细修正更改主功能`);
    return {...item,featureId};
  });
  const clarifications:Clarification[]=[];
  const deleteRequirementIds=stringList(raw.deleteRequirementIds,'deleteRequirementIds'),deleteClarificationIds=stringList(raw.deleteClarificationIds,'deleteClarificationIds');
  for(const id of deleteRequirementIds)if(!scope.requirementIds.includes(id))throw new DomainValidationError(`越界删除 ${id}`);
  for(const id of deleteClarificationIds)if(!scope.clarificationIds.includes(id))throw new DomainValidationError(`越界删除 ${id}`);
  const ids=[...requirements,...clarifications].map(item=>item.id);if(new Set(ids).size!==ids.length)throw new DomainValidationError('增量产生重复 ID');
  if(ids.some(id=>deleteRequirementIds.includes(id)||deleteClarificationIds.includes(id)))throw new DomainValidationError('同一条目不能同时修改与删除');
  return {requirements,clarifications,deleteRequirementIds,deleteClarificationIds};
}

/** 在当前最新项目上串行提交，不能用调用开始时的数组长度分配编号。 */
export function applyRequirementPatch(project:PrdProject,scope:RepairScope,patch:RequirementPatch,allocateIds:boolean,resolvedSourceUnitIds:ReadonlySet<string>=new Set()):PrdProject {
  const previouslyUncovered=new Set(validateDirectGraph(project.sourceUnits,project.sourceDispositions??[],project.features,project.requirements,project.clarifications).uncovered.map(item=>item.sourceUnitId));
  const validated=acceptRequirementPatch(patch,project,scope),result=structuredClone(project);
  const allIds=[...project.requirements,...project.clarifications].map(item=>item.id);
  const next=(prefix:string)=>Math.max(0,...allIds.map(id=>Number(id.match(new RegExp(`^${prefix}-(\\d+)$`))?.[1]??0)))+1;
  let nextR=next('R'),nextQ=next('Q');
  const mapping=new Map<string,string>();
  for(const item of validated.requirements)mapping.set(item.id,allocateIds&&item.id.startsWith('LOCAL-')?`R-${String(nextR++).padStart(4,'0')}`:item.id);
  for(const item of validated.clarifications)mapping.set(item.id,allocateIds&&item.id.startsWith('LOCAL-')?`Q-${String(nextQ++).padStart(4,'0')}`:item.id);
  const changedR=new Set(validated.requirements.map(item=>item.id)),changedQ=new Set(validated.clarifications.map(item=>item.id));
  result.requirements=result.requirements.filter(item=>!changedR.has(item.id)&&!validated.deleteRequirementIds.includes(item.id));
  result.requirements.push(...validated.requirements.map(item=>({...item,id:mapping.get(item.id)!})));
  result.clarifications=result.clarifications.filter(item=>!changedQ.has(item.id)&&!validated.deleteClarificationIds.includes(item.id));
  result.clarifications.push(...validated.clarifications.map(item=>({...item,id:mapping.get(item.id)!,affectedIds:item.affectedIds.map(id=>mapping.get(id)??id)})));
  for(const feature of result.features){feature.requirementIds=feature.requirementIds.filter(id=>!changedR.has(id)&&!validated.deleteRequirementIds.includes(id));feature.requirementIds.push(...validated.requirements.filter(item=>item.featureId===feature.id).map(item=>mapping.get(item.id)!));}
  const requirementIds=new Set(result.requirements.map(item=>item.id));result.relations=result.relations?.filter(relation=>requirementIds.has(relation.sourceRequirementId)&&requirementIds.has(relation.targetRequirementId));
  const graph=validateDirectGraph(result.sourceUnits,result.sourceDispositions??[],result.features,result.requirements,result.clarifications);
  const required=new Set(scope.requiredSourceUnitIds);
  const invalid=graph.uncovered.filter(item=>!resolvedSourceUnitIds.has(item.sourceUnitId)&&(!previouslyUncovered.has(item.sourceUnitId)||required.has(item.sourceUnitId)));
  if(invalid.length)throw new DomainValidationError(`增量修正仍有未覆盖原文：${invalid.map(item=>item.sourceUnitId).join('、')}`);
  return result;
}

export function validateRepair(before:RequirementDetail[], candidate:RequirementDetail[], project:PrdProject) {
  const ids=new Set(before.map(item=>item.id));
  if(candidate.length!==before.length||candidate.some(item=>!ids.has(item.id)))throw new DomainValidationError('定点返工必须保留本功能全部需求ID');
  acceptDirectDetails(candidate,[],project.sourceUnits,true);
  for(const old of before){const replacement=candidate.find(item=>item.id===old.id)!;if(replacement.featureId!==old.featureId)throw new DomainValidationError('定点返工不得更改主功能');}

}

export const repairInstructions='仅修复 issues 指出的需求条目偏差，依据主 PRD，不增加业务假设。每项只有 id、featureId、text、evidenceIds，text 是简短清单表述，保留原文明示的必要限定；仅输出 requirements 和 deleteRequirementIds，不生成问题、建议或澄清。保留原 ID 与功能归属，不修改范围外内容。';

export function nextRuleId(rules:RequirementRule[]){return Math.max(0,...rules.map(rule=>Number(rule.id.match(/RL-(\d+)/)?.[1]??0)))+1}

export function applyRuleRepair(current:RequirementRule[], removeIds:string[], replacements:RequirementRule[]) {
  const removable=new Set(removeIds), known=new Set(current.map(rule=>rule.id));
  for(const id of removable)if(!known.has(id))throw new DomainValidationError(`规则返工试图删除不存在的规则 ${id}`);
  let next=nextRuleId(current);
  const normalized=replacements.map(rule=>({...rule,id:rule.id.startsWith('RL-')&&removable.has(rule.id)?rule.id:`RL-${String(next++).padStart(4,'0')}`}));
  const ids=new Set(normalized.map(rule=>rule.id));if(ids.size!==normalized.length)throw new DomainValidationError('规则返工产生重复ID');
  return current.filter(rule=>!removable.has(rule.id)).concat(normalized);
}

/** 一轮只选择一个小型、来源相连的问题簇，防止“定点返工”退化为全局重写。 */
export function selectRuleRepairBatch(issues:AuditIssue[], maxSources=12, maxIssues=8) {
  for(const seed of issues){
    if(new Set(seed.sourceUnitIds).size>maxSources)continue;
    const selected=[seed],sources=new Set(seed.sourceUnitIds);
    let changed=true;
    while(changed&&selected.length<maxIssues){changed=false;for(const issue of issues){if(selected.includes(issue)||!issue.sourceUnitIds.some(id=>sources.has(id)))continue;const union=new Set([...sources,...issue.sourceUnitIds]);if(union.size>maxSources)continue;selected.push(issue);for(const id of issue.sourceUnitIds)sources.add(id);changed=true;if(selected.length>=maxIssues)break}}
    return selected;
  }
  return [];
}
