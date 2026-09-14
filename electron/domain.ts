import { DomainValidationError } from './node-validation.js';
import { auditCategories } from './audit-repair.js';
import type { Clarification, Feature, RequirementDetail, RequirementRelation, RequirementRule, SourceDisposition, SourceRef, SourceUnit } from '../src/types.js';

const ruleKinds = new Set(['behavior','condition','constraint','exception','data','permission','nonfunctional','state','validation','migration','dependency','unknown']);
const reviewStates = new Set(['draft','needs-clarification','reviewed']);
const text = (value: unknown, path: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new DomainValidationError(`${path} 必须是非空文本`);
  return value.trim();
};
const strings = (value: unknown, path: string, allowEmpty = true) => {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim()) || (!allowEmpty && value.length === 0)) {
    throw new DomainValidationError(`${path} 必须是${allowEmpty ? '' : '非空'}文本数组`);
  }
  return value.map(item => item.trim());
};
const uniqueIds = (items: Array<{id:string}>, path: string) => {
  const seen = new Set<string>();
  for (const item of items) { if (seen.has(item.id)) throw new DomainValidationError(`${path} 存在重复 ID：${item.id}`); seen.add(item.id); }
};
const refs = (ids: string[], known: Set<string>, path: string) => {
  const missing = ids.filter(id => !known.has(id));
  if (missing.length) throw new DomainValidationError(`${path} 引用了不存在的 ID：${missing.join('、')}`);
};
const sourceRefs = (item:Record<string,unknown>, units:SourceUnit[], path:string):SourceRef[] => {
  if (Array.isArray(item.sourceRefs)) return item.sourceRefs.map((raw,index)=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new DomainValidationError(`${path}.sourceRefs[${index}] 必须是对象`);
    const ref=raw as Record<string,unknown>,sourceUnitId=text(ref.sourceUnitId,`${path}.sourceRefs[${index}].sourceUnitId`),unit=units.find(value=>value.id===sourceUnitId);
    if(!unit)throw new DomainValidationError(`${path}.sourceRefs[${index}] 引用了不存在的 ID：${sourceUnitId}`);
    if(ref.quote===undefined){
      if(ref.start===undefined&&ref.end===undefined)return{sourceUnitId};
      if(!Number.isInteger(ref.start)||!Number.isInteger(ref.end))throw new DomainValidationError(`${path}.sourceRefs[${index}] 选区必须使用整数边界`);
      const start=ref.start as number,end=ref.end as number,haystack=unit.asset?.extractedText??unit.excerpt;
      if(start<0||end<=start||end>haystack.length)throw new DomainValidationError(`${path}.sourceRefs[${index}] 选区超出指定原文范围`);
      return{sourceUnitId,start,end};
    }
    const quote=text(ref.quote,`${path}.sourceRefs[${index}].quote`),haystack=unit.asset?.extractedText??unit.excerpt,first=haystack.indexOf(quote);
    if(first<0)throw new DomainValidationError(`${path}.sourceRefs[${index}] 引用文字不在指定原文中`);
    if(haystack.indexOf(quote,first+1)>=0)throw new DomainValidationError(`${path}.sourceRefs[${index}] 引用文字在原文中不唯一`);
    return{sourceUnitId,start:first,end:first+quote.length};
  });
  return strings(item.sourceUnitIds,`${path}.sourceUnitIds`,false).map(sourceUnitId=>({sourceUnitId}));
};
const clarificationLevels = new Set(['blocking','suggestion','ignorable']);
const clarificationFrom = (item:Record<string,unknown>,index:number,units:SourceUnit[],knownAffected:Set<string>):Clarification => {
  const path=`clarifications[${index}]`,state=text(item.state,`${path}.state`);if(state!=='open')throw new DomainValidationError(`${path} 模型不得自动解决待确认事项`);
  const level=text(item.level,`${path}.level`);if(!clarificationLevels.has(level))throw new DomainValidationError(`${path}.level 仅允许 blocking、suggestion 或 ignorable`);
  const affectedIds=strings(item.affectedIds,`${path}.affectedIds`,false);refs(affectedIds,knownAffected,`${path}.affectedIds`);
  const question=text(item.question,`${path}.question`),reason=text(item.reason,`${path}.reason`),knownFacts=text(item.knownFacts,`${path}.knownFacts`),unresolvedPoint=text(item.unresolvedPoint,`${path}.unresolvedPoint`),impact=text(item.impact,`${path}.impact`),levelReason=text(item.levelReason,`${path}.levelReason`);
  if(question.length<8||/^(NULL|统一处理[。.]?|请人工确认该原文应如何整理为需求明细[。.]?)$/i.test(question))throw new DomainValidationError(`${path}.question 必须是用户可直接理解和回答的完整业务问题`);
  const selected=sourceRefs(item,units,path);if(!selected.length)throw new DomainValidationError(`${path}.sourceRefs 不得为空`);
  const defaultResolution=item.defaultResolution===undefined?undefined:text(item.defaultResolution,`${path}.defaultResolution`);
  if(level==='suggestion'&&!defaultResolution)throw new DomainValidationError(`${path}.defaultResolution 必须说明暂不处理时沿用的明确口径`);
  let resolutionProposal:Clarification['resolutionProposal'];
  if(level==='blocking'){
    if(!item.resolutionProposal||typeof item.resolutionProposal!=='object'||Array.isArray(item.resolutionProposal))throw new DomainValidationError(`${path}.resolutionProposal 必须为阻塞事项给出可执行建议`);
    const proposal=item.resolutionProposal as Record<string,unknown>,proposalIds=Array.isArray(proposal.evidenceIds)?strings(proposal.evidenceIds,`${path}.resolutionProposal.evidenceIds`,false):Array.isArray(proposal.sourceRefs)?(proposal.sourceRefs as Array<Record<string,unknown>>).map((ref,index)=>text(ref.sourceUnitId,`${path}.resolutionProposal.sourceRefs[${index}].sourceUnitId`)):[],knownSources=new Set(selected.map(ref=>ref.sourceUnitId));
    if(!proposalIds.length)throw new DomainValidationError(`${path}.resolutionProposal.evidenceIds 不得为空`);
    refs(proposalIds,knownSources,`${path}.resolutionProposal.evidenceIds`);
    const recommendation=text(proposal.recommendation,`${path}.resolutionProposal.recommendation`),confirmation=text(proposal.confirmation,`${path}.resolutionProposal.confirmation`);
    if(recommendation.length<12||/请.{0,6}(确认|决定|补充)[。.]?$/.test(recommendation))throw new DomainValidationError(`${path}.resolutionProposal.recommendation 必须给出具体口径，不能只要求用户确认`);
    resolutionProposal={recommendation,rationale:text(proposal.rationale,`${path}.resolutionProposal.rationale`),impact:text(proposal.impact,`${path}.resolutionProposal.impact`),confirmation,alternatives:strings(proposal.alternatives??[],`${path}.resolutionProposal.alternatives`).slice(0,2),sourceRefs:proposalIds.map(sourceUnitId=>({sourceUnitId}))};
  }
  return{id:text(item.id,`${path}.id`),question,reason,level:level as Clarification['level'],knownFacts,unresolvedPoint,impact,levelReason,...(defaultResolution?{defaultResolution}:{}),...(resolutionProposal?{resolutionProposal}:{}),sourceRefs:selected,affectedIds,state:'open'};
};
export function acceptDirectClarifications(value:unknown,sourceUnits:SourceUnit[],knownAffectedIds:string[]){
  if(!Array.isArray(value))throw new DomainValidationError('clarifications 必须是数组');
  const clarifications=value.map((raw,index)=>clarificationFrom(raw as Record<string,unknown>,index,sourceUnits,new Set(knownAffectedIds)));
  uniqueIds(clarifications,'clarifications');return clarifications;
}
const featureFrom = (item:Record<string,unknown>, index:number, units:SourceUnit[]):Feature => {
  const state=text(item.state,`features[${index}].state`);if(!reviewStates.has(state))throw new DomainValidationError(`features[${index}].state 非法`);
  const selected=sourceRefs(item,units,`features[${index}]`);
  return{id:text(item.id,`features[${index}].id`),name:text(item.name,`features[${index}].name`),sourceRefs:selected,sourceUnitIds:[...new Set(selected.map(ref=>ref.sourceUnitId))],ruleIds:[],requirementIds:[],kind:featureKind(item.kind),state:state as Feature['state']};
};

export function acceptRules(value: unknown, sourceUnits: SourceUnit[]) {
  if (!Array.isArray(value)) throw new DomainValidationError('rules 必须是数组');
  const sourceIds = new Set(sourceUnits.map(unit => unit.id));
  const rules = value.map((raw, index) => {
    const item = raw as Record<string,unknown>, kind = text(item.kind, `rules[${index}].kind`), status = text(item.status, `rules[${index}].status`);
    if (!ruleKinds.has(kind)) throw new DomainValidationError(`rules[${index}].kind 非法：${kind}`);
    if (status !== 'explicit' && status !== 'unknown') throw new DomainValidationError(`rules[${index}].status 非法`);
    if (kind === 'unknown' && status !== 'unknown') throw new DomainValidationError(`rules[${index}] 只有 status=unknown 时才允许 kind=unknown`);
    const rule: RequirementRule = { id:text(item.id,`rules[${index}].id`), statement:text(item.statement,`rules[${index}].statement`), sourceUnitIds:strings(item.sourceUnitIds,`rules[${index}].sourceUnitIds`,false), conditions:strings(item.conditions,`rules[${index}].conditions`), kind:kind as RequirementRule['kind'], status:status as RequirementRule['status'] };
    refs(rule.sourceUnitIds, sourceIds, `rules[${index}].sourceUnitIds`);
    return rule;
  });
  uniqueIds(rules, 'rules');
  return rules;
}

export function acceptFeatures(value: unknown, rules: RequirementRule[], sourceUnits: SourceUnit[]) {
  if (!Array.isArray(value)) throw new DomainValidationError('features 必须是数组');
  const ruleIds = new Set(rules.map(rule => rule.id)), sourceIds = new Set(sourceUnits.map(unit => unit.id));
  const features = value.map((raw,index) => {
    const item=raw as Record<string,unknown>, feature=featureFrom(item,index,sourceUnits);feature.ruleIds=strings(item.ruleIds,`features[${index}].ruleIds`,false);
    refs(feature.ruleIds,ruleIds,`features[${index}].ruleIds`);refs(feature.sourceUnitIds,sourceIds,`features[${index}].sourceUnitIds`);return feature;
  });
  uniqueIds(features,'features'); return features;
}

export function acceptDetails(requirementsValue: unknown, questionsValue: unknown, rules: RequirementRule[], sourceUnits: SourceUnit[]) {
  if(!Array.isArray(requirementsValue)||!Array.isArray(questionsValue))throw new DomainValidationError('需求细化必须同时返回 requirements 与 clarifications 数组');
  const ruleIds=new Set(rules.map(rule=>rule.id)),sourceIds=new Set(sourceUnits.map(unit=>unit.id));
  const parsedRequirements=requirementsValue.map((raw,index)=>{const item=raw as Record<string,unknown>,state=text(item.state,`requirements[${index}].state`);if(!reviewStates.has(state))throw new DomainValidationError(`requirements[${index}].state 非法`);const requirement:RequirementDetail={id:text(item.id,`requirements[${index}].id`),title:text(item.title,`requirements[${index}].title`),behavior:text(item.behavior,`requirements[${index}].behavior`),conditions:strings(item.conditions,`requirements[${index}].conditions`),constraints:strings(item.constraints,`requirements[${index}].constraints`),explicitAcceptanceConditions:strings(item.explicitAcceptanceConditions,`requirements[${index}].explicitAcceptanceConditions`),sourceUnitIds:strings(item.sourceUnitIds,`requirements[${index}].sourceUnitIds`,false),ruleIds:strings(item.ruleIds,`requirements[${index}].ruleIds`,false),state:state as RequirementDetail['state']};refs(requirement.ruleIds,ruleIds,`requirements[${index}].ruleIds`);refs(requirement.sourceUnitIds,sourceIds,`requirements[${index}].sourceUnitIds`);return requirement});
  uniqueIds(parsedRequirements,'requirements');
  const downgraded=new Map(parsedRequirements.filter(requirement=>!rules.some(rule=>requirement.ruleIds.includes(rule.id)&&rule.status==='explicit')).map(requirement=>[requirement.id,requirement]));
  const requirements=parsedRequirements.filter(requirement=>!downgraded.has(requirement.id));
  const normalize=(value:string)=>value.replace(/\s/g,'').toLocaleLowerCase('en-US');
  for(const requirement of requirements){
    const originals=sourceUnits.filter(unit=>requirement.sourceUnitIds.includes(unit.id)).map(unit=>normalize([unit.excerpt,unit.context??'',unit.asset?.extractedText??''].join('\n')));
    requirement.explicitAcceptanceConditions=requirement.explicitAcceptanceConditions.filter(condition=>originals.some(original=>original.includes(normalize(condition))));
  }
  const localIds=new Set(parsedRequirements.map(item=>item.id));
  const clarifications=questionsValue.map((raw,index)=>{const item=raw as Record<string,unknown>,state=text(item.state,`clarifications[${index}].state`);if(state!=='open')throw new DomainValidationError(`clarifications[${index}] 模型不得自动解决待确认事项`);const affected=strings(item.affectedIds,`clarifications[${index}].affectedIds`,false);refs(affected,new Set([...ruleIds,...localIds]),`clarifications[${index}].affectedIds`);const affectedIds=Array.from(new Set(affected.flatMap(id=>downgraded.get(id)?.ruleIds??[id])));const question:Clarification={id:text(item.id,`clarifications[${index}].id`),question:text(item.question,`clarifications[${index}].question`),reason:text(item.reason,`clarifications[${index}].reason`),affectedIds,state:state as Clarification['state']};return question});
  for(const requirement of downgraded.values())if(!clarifications.some(question=>question.affectedIds.some(id=>requirement.ruleIds.includes(id))))clarifications.push({id:`AUTO-Q-${requirement.id}`,question:`请确认“${requirement.title}”的具体业务要求。`,reason:`模型将待确认规则整理为确定需求，平台已降级；原描述：${requirement.behavior}`,affectedIds:requirement.ruleIds,state:'open'});
  uniqueIds(clarifications,'clarifications');return{requirements,clarifications};
}

export function validateGraph(sourceUnits:SourceUnit[],rules:RequirementRule[],features:Feature[],requirements:RequirementDetail[],clarifications:Clarification[]){
  if(sourceUnits.some(unit=>unit.status!=='processed'))throw new DomainValidationError('仍有未读取的原文单元');
  if(sourceUnits.some(unit=>unit.excerpt.trim())&&rules.length===0)throw new DomainValidationError('原文包含内容但规则提取为空');
  const sourceIds=new Set(sourceUnits.map(x=>x.id)),ruleIds=new Set(rules.map(x=>x.id)),requirementIds=new Set(requirements.map(x=>x.id));
  for(const rule of rules)refs(rule.sourceUnitIds,sourceIds,`${rule.id}.sourceUnitIds`);
  for(const feature of features){refs(feature.ruleIds,ruleIds,`${feature.id}.ruleIds`);refs(feature.requirementIds,requirementIds,`${feature.id}.requirementIds`)}
  for(const requirement of requirements){refs(requirement.ruleIds,ruleIds,`${requirement.id}.ruleIds`);refs(requirement.sourceUnitIds,sourceIds,`${requirement.id}.sourceUnitIds`)}
  for(const question of clarifications)refs(question.affectedIds,new Set([...ruleIds,...requirementIds]),`${question.id}.affectedIds`);
  const assigned=new Set(features.flatMap(feature=>feature.ruleIds));const implemented=new Set(requirements.flatMap(requirement=>requirement.ruleIds));
  return{unassigned:rules.filter(rule=>!assigned.has(rule.id)),unimplemented:rules.filter(rule=>rule.status==='explicit'&&!implemented.has(rule.id)),unknown:rules.filter(rule=>rule.status==='unknown')};
}

export function acceptAuditIssues(value:unknown,sourceUnits:SourceUnit[],rules:RequirementRule[],features:Feature[],requirements:RequirementDetail[],clarifications:Clarification[],relations:RequirementRelation[]=[]){
  if(!Array.isArray(value))throw new DomainValidationError('issues 必须是数组');
  const sourceIds=new Set(sourceUnits.map(item=>item.id)),affectedIds=new Set([...sourceUnits,...rules,...features,...requirements,...clarifications,...relations].map(item=>item.id));
  const owners=new Set(['feature-grouping','requirement-detail','requirement-relation','source-decision','runtime-output']);
  const issues=value.map((raw,index)=>{const item=raw as Record<string,unknown>,direction=text(item.direction,`issues[${index}].direction`);if(!['forward','reverse','cross'].includes(direction))throw new DomainValidationError(`issues[${index}].direction 非法`);const sourceUnitIds=strings(item.sourceUnitIds,`issues[${index}].sourceUnitIds`,false),affected=strings(item.affectedIds,`issues[${index}].affectedIds`,false);refs(sourceUnitIds,sourceIds,`issues[${index}].sourceUnitIds`);refs(affected,affectedIds,`issues[${index}].affectedIds`);if(item.category!==undefined&&!auditCategories.has(item.category as never))throw new DomainValidationError('审计问题分类非法');if(item.owner!==undefined&&!owners.has(item.owner as string))throw new DomainValidationError('审计问题责任非法');const category=item.category as import('../src/types.js').AuditCategory|undefined;const clarificationDraft=category==='source-ambiguity'?clarificationFrom(item.clarification as Record<string,unknown>,index,sourceUnits,affectedIds):undefined;return{category,owner:item.owner as import('../src/types.js').AuditOwner|undefined,id:text(item.id,`issues[${index}].id`),direction,type:text(item.type,`issues[${index}].type`),sourceUnitIds,affectedIds:affected,detail:text(item.detail,`issues[${index}].detail`),...(clarificationDraft?{clarificationDraft}: {})}});uniqueIds(issues,'issues');return issues;
}

const dispositionKinds=new Set(['requirement','clarification','context','example','summary','out-of-scope']);
const featureKind=(value:unknown):Feature['kind']=>{if(value===undefined)return 'function';if(value!=='function'&&value!=='constraint')throw new DomainValidationError('功能 kind 仅允许 function 或 constraint，待澄清事项不能作为功能');return value};
function acceptConstraintTargets(features:Feature[],rawFeatures:unknown[]){
  const known=new Set(features.map(item=>item.id));
  features.forEach((feature,index)=>{
    const raw=rawFeatures[index] as Record<string,unknown>;
    if(raw.appliesToFeatureIds===undefined)return;
    const ids=strings(raw.appliesToFeatureIds,`${feature.id}.appliesToFeatureIds`);
    if(new Set(ids).size!==ids.length)throw new DomainValidationError(`${feature.id}.appliesToFeatureIds 存在重复目标`);
    refs(ids,known,`${feature.id}.appliesToFeatureIds`);
    if(ids.includes(feature.id))throw new DomainValidationError(`${feature.id}.appliesToFeatureIds 禁止自引用`);
    if(feature.kind!=='constraint'&&ids.length)throw new DomainValidationError(`${feature.id} 仅 constraint 可声明适用功能`);
    feature.appliesToFeatureIds=ids;
  });
}

export function acceptDirectFeatureBatch(featuresValue:unknown,dispositionsValue:unknown,sourceUnits:SourceUnit[]){
  if(!Array.isArray(featuresValue)||!Array.isArray(dispositionsValue))throw new DomainValidationError('功能识别必须同时返回 features 与 sourceDispositions 数组');
  const sourceIds=new Set(sourceUnits.map(unit=>unit.id)),sourceById=new Map(sourceUnits.map(unit=>[unit.id,unit]));
  const features=featuresValue.map((raw,index)=>{const feature=featureFrom(raw as Record<string,unknown>,index,sourceUnits);refs(feature.sourceUnitIds,sourceIds,`features[${index}].sourceUnitIds`);return feature});
  uniqueIds(features,'features');acceptConstraintTargets(features,featuresValue);const featureIds=new Set(features.map(feature=>feature.id));
  const dispositions=dispositionsValue.map((raw,index)=>{const item=raw as Record<string,unknown>,declaredRole=text(item.contentRole,`sourceDispositions[${index}].contentRole`);if(!dispositionKinds.has(declaredRole))throw new DomainValidationError(`sourceDispositions[${index}].contentRole 非法：${declaredRole.slice(0,80)}；允许：${[...dispositionKinds].join("、")}`);const sourceUnitId=text(item.sourceUnitId,`sourceDispositions[${index}].sourceUnitId`);refs([sourceUnitId],sourceIds,`sourceDispositions[${index}].sourceUnitId`);const heading=sourceById.get(sourceUnitId)?.kind==='heading',contentRole=heading&&declaredRole==='requirement'?'context':declaredRole;const disposition:SourceDisposition={sourceUnitId,kind:contentRole as SourceDisposition['kind'],reason:heading&&declaredRole==='requirement'?'章节标题仅用于结构定位和功能命名，其业务要求由章节正文承接。':text(item.reason,`sourceDispositions[${index}].reason`),featureIds:strings(item.featureIds,`sourceDispositions[${index}].featureIds`)};refs(disposition.featureIds,featureIds,`sourceDispositions[${index}].featureIds`);return disposition});
  const seen=new Set(dispositions.map(item=>item.sourceUnitId)),missing=sourceUnits.filter(unit=>!seen.has(unit.id));if(seen.size!==dispositions.length)throw new DomainValidationError('sourceDispositions 存在重复来源');if(missing.length)throw new DomainValidationError(`sourceDispositions 遗漏 ${missing.map(unit=>unit.id).join('、')}`);
  for(const disposition of dispositions.filter(item=>item.kind==='requirement'||item.kind==='clarification'))for(const featureId of disposition.featureIds){const feature=features.find(item=>item.id===featureId)!;if(!feature.sourceUnitIds.includes(disposition.sourceUnitId)){feature.sourceUnitIds.push(disposition.sourceUnitId);(feature.sourceRefs??=[]).push({sourceUnitId:disposition.sourceUnitId})}}
  return{features,dispositions};
}

export function acceptDirectFeatures(value:unknown,sourceUnits:SourceUnit[]){
  if(!Array.isArray(value))throw new DomainValidationError('features 必须是数组');const sourceIds=new Set(sourceUnits.map(unit=>unit.id));
  const features=value.map((raw,index)=>{const feature=featureFrom(raw as Record<string,unknown>,index,sourceUnits);refs(feature.sourceUnitIds,sourceIds,`features[${index}].sourceUnitIds`);return feature});uniqueIds(features,'features');acceptConstraintTargets(features,value);return features;
}

/** 统一节点仅报告分类错误，由控制器返回候选识别，不在此删除原文。 */
export function acceptCandidateClassificationIssues(value:unknown,candidates:Feature[],sourceUnits:SourceUnit[]){
  if(!Array.isArray(value))throw new DomainValidationError('classificationIssues 必须是数组');
  const candidateById=new Map(candidates.map(item=>[item.id,item])),sourceIds=new Set(sourceUnits.map(item=>item.id));
  return value.map((raw,index)=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new DomainValidationError(`classificationIssues[${index}] 必须是对象`);
    const item=raw as Record<string,unknown>,candidateIds=strings(item.candidateIds,`classificationIssues[${index}].candidateIds`,false),sourceUnitIds=strings(item.sourceUnitIds,`classificationIssues[${index}].sourceUnitIds`,false),detail=text(item.detail,`classificationIssues[${index}].detail`);
    refs(candidateIds,new Set(candidateById.keys()),`classificationIssues[${index}].candidateIds`);refs(sourceUnitIds,sourceIds,`classificationIssues[${index}].sourceUnitIds`);
    const candidateSources=new Set(candidateIds.flatMap(id=>candidateById.get(id)!.sourceUnitIds));
    if(sourceUnitIds.some(id=>!candidateSources.has(id)))throw new DomainValidationError(`classificationIssues[${index}] 来源超出所列候选范围`);
    return{candidateIds,sourceUnitIds,detail};
  });
}

/** 统一节点只能通过显式候选映射合并或拆分，来源不能按相似度补回。 */
export function acceptFeatureUnification(value:unknown,candidates:Feature[],sourceUnits:SourceUnit[]):Feature[]{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new DomainValidationError('功能统一必须返回 features 与 candidateMappings');
  const payload=value as Record<string,unknown>;
  if(!Array.isArray(payload.features))throw new DomainValidationError('features 必须是数组');
  if(!Array.isArray(payload.candidateMappings))throw new DomainValidationError('candidateMappings 必须是数组');
  uniqueIds(candidates,'candidates');
  const omitted=payload.features.map(raw=>!!raw&&typeof raw==='object'&&!Object.prototype.hasOwnProperty.call(raw,'sourceUnitIds')&&!Object.prototype.hasOwnProperty.call(raw,'sourceRefs'));
  if(omitted.some(Boolean)&&!omitted.every(Boolean))throw new DomainValidationError('features 不允许混用省略来源与显式来源');
  let featureValues=payload.features;
  if(omitted.length&&omitted.every(Boolean)){
    const candidateMap=new Map(candidates.map(item=>[item.id,item])),compiled=new Map<string,SourceRef[]>(),unitById=new Map(sourceUnits.map(unit=>[unit.id,unit]));
    for(const raw of featureValues){const item=raw as Record<string,unknown>,id=text(item.id,'features.id');if(compiled.has(id))throw new DomainValidationError(`features 存在重复 ID：${id}`);compiled.set(id,[])}
    const normalized=(ref:SourceRef)=>{const unit=unitById.get(ref.sourceUnitId);if(!unit)throw new DomainValidationError(`候选引用了不存在的来源：${ref.sourceUnitId}`);const length=(unit.asset?.extractedText??unit.excerpt).length;return{sourceUnitId:ref.sourceUnitId,start:ref.start??0,end:ref.end??length}};
    const add=(target:string,ref:SourceRef)=>{const list=compiled.get(target)!;if(!list.some(item=>JSON.stringify(item)===JSON.stringify(ref)))list.push(ref)};
    for(const raw of payload.candidateMappings){
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new DomainValidationError('candidateMappings 必须包含对象');
      const item=raw as Record<string,unknown>,candidateId=text(item.candidateId,'candidateMappings.candidateId'),targets=strings(item.featureIds,'candidateMappings.featureIds',false);
      refs([candidateId],new Set(candidateMap.keys()),'candidateMappings.candidateId');refs(targets,new Set(compiled.keys()),'candidateMappings.featureIds');
      const candidate=candidateMap.get(candidateId)!;
      const candidateRefs=candidate.sourceRefs?.length?candidate.sourceRefs:candidate.sourceUnitIds.map(sourceUnitId=>({sourceUnitId}));
      if(targets.length===1){if(item.sourceRefsByFeature!==undefined)throw new DomainValidationError(`${candidateId} 单目标映射由平台继承完整来源，不得提交 allocations`);candidateRefs.forEach(ref=>add(targets[0],ref));continue}
      const allocation=item.sourceRefsByFeature;
      if(!allocation||typeof allocation!=='object'||Array.isArray(allocation))throw new DomainValidationError(`${candidateId} 多目标映射必须提供 allocations`);
      const entries=allocation as Record<string,unknown>,keys=Object.keys(entries);
      if(keys.length!==targets.length||keys.some(id=>!targets.includes(id)))throw new DomainValidationError(`${candidateId} allocations 的 featureId 必须恰为目标集合`);
      const allocated:SourceRef[]=[];
      for(const id of targets){const selected=sourceRefs({sourceRefs:entries[id]},sourceUnits,`${candidateId}.sourceRefsByFeature.${id}`);for(const ref of selected){const range=normalized(ref);if(!candidateRefs.map(normalized).some(parent=>parent.sourceUnitId===range.sourceUnitId&&parent.start<=range.start&&parent.end>=range.end))throw new DomainValidationError(`${candidateId} 证据分配超出候选选区`);allocated.push(ref);add(id,ref)}}
      for(const parent of candidateRefs.map(normalized)){const ranges=allocated.map(normalized).filter(ref=>ref.sourceUnitId===parent.sourceUnitId&&ref.end>parent.start&&ref.start<parent.end).sort((a,b)=>a.start-b.start);let end=parent.start;for(const range of ranges){if(range.start>end)break;end=Math.max(end,range.end)}if(end<parent.end)throw new DomainValidationError(`${candidateId} 证据分配遗漏候选选区`)}
    }
    featureValues=featureValues.map(raw=>{const item=raw as Record<string,unknown>;return{...item,sourceRefs:compiled.get(item.id as string)!}});
  }
  const features=acceptDirectFeatures(featureValues,sourceUnits);
  const candidateById=new Map(candidates.map(item=>[item.id,item])),featureById=new Map(features.map(item=>[item.id,item])),sourceIds=new Set(sourceUnits.map(item=>item.id));
  for(const candidate of candidates)refs(candidate.sourceUnitIds,sourceIds,`${candidate.id}.sourceUnitIds`);
  const mappedCandidates=new Set<string>(),allowedSources=new Map<string,Set<string>>();
  for(const [index,raw] of payload.candidateMappings.entries()){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new DomainValidationError(`candidateMappings[${index}] 必须是对象`);
    const item=raw as Record<string,unknown>,candidateId=text(item.candidateId,`candidateMappings[${index}].candidateId`),targets=strings(item.featureIds,`candidateMappings[${index}].featureIds`,false);
    refs([candidateId],new Set(candidateById.keys()),'candidateMappings.candidateId');refs(targets,new Set(featureById.keys()),'candidateMappings.featureIds');
    if(mappedCandidates.has(candidateId))throw new DomainValidationError(`candidateMappings 候选重复映射：${candidateId}`);
    if(new Set(targets).size!==targets.length)throw new DomainValidationError(`candidateMappings ${candidateId} 存在重复目标`);
    mappedCandidates.add(candidateId);const candidate=candidateById.get(candidateId)!;
    const retained=new Set(targets.flatMap(id=>featureById.get(id)!.sourceUnitIds));
    const missing=candidate.sourceUnitIds.filter(id=>!retained.has(id));if(missing.length)throw new DomainValidationError(`${candidateId} 映射目标遗漏候选来源：${missing.join('、')}`);
    for(const id of targets){const allowed=allowedSources.get(id)??new Set<string>();candidate.sourceUnitIds.forEach(sourceId=>allowed.add(sourceId));allowedSources.set(id,allowed)}
  }
  const missingCandidates=candidates.filter(item=>!mappedCandidates.has(item.id));if(missingCandidates.length)throw new DomainValidationError(`candidateMappings 遗漏候选：${missingCandidates.map(item=>item.id).join('、')}`);
  for(const feature of features){const allowed=allowedSources.get(feature.id);if(!allowed)throw new DomainValidationError(`${feature.id} 没有候选映射`);const invented=feature.sourceUnitIds.filter(id=>!allowed.has(id));if(invented.length)throw new DomainValidationError(`${feature.id} 包含映射候选之外的来源：${invented.join('、')}`)}
  return features;
}

export function acceptDirectDetails(requirementsValue:unknown,questionsValue:unknown,sourceUnits:SourceUnit[],requireEvidenceBindings=false){
  if(!Array.isArray(requirementsValue)||!Array.isArray(questionsValue))throw new DomainValidationError('需求细化必须同时返回 requirements 与 clarifications 数组');const sourceIds=new Set(sourceUnits.map(unit=>unit.id));
  const requirements=requirementsValue.map((raw,index)=>{const item=raw as Record<string,unknown>,state=text(item.state,`requirements[${index}].state`);if(!reviewStates.has(state))throw new DomainValidationError(`requirements[${index}].state 非法`);const requirement:RequirementDetail={id:text(item.id,`requirements[${index}].id`),title:text(item.title,`requirements[${index}].title`),behavior:text(item.behavior,`requirements[${index}].behavior`),conditions:strings(item.conditions,`requirements[${index}].conditions`),constraints:strings(item.constraints,`requirements[${index}].constraints`),explicitAcceptanceConditions:strings(item.explicitAcceptanceConditions,`requirements[${index}].explicitAcceptanceConditions`),sourceUnitIds:strings(item.sourceUnitIds,`requirements[${index}].sourceUnitIds`,false),ruleIds:[],state:state as RequirementDetail['state']};refs(requirement.sourceUnitIds,sourceIds,`requirements[${index}].sourceUnitIds`);
    const all=requirement.sourceUnitIds.map(sourceUnitId=>({sourceUnitId}));const rawBindings=item.evidenceBindings;if(requireEvidenceBindings&&rawBindings===undefined)throw new DomainValidationError(`${requirement.id}.evidenceBindings 缺失，当前流程必须逐字段选择直接证据`);
    if(rawBindings!==undefined){if(!rawBindings||typeof rawBindings!=='object'||Array.isArray(rawBindings))throw new DomainValidationError(`${requirement.id}.evidenceBindings 必须是对象`);const binding=rawBindings as Record<string,unknown>,one=(value:unknown,label:string)=>{const selected=Array.isArray(value)?sourceRefs({sourceRefs:value},sourceUnits,label):value&&typeof value==='object'?(()=>{const entry=value as Record<string,unknown>;return sourceRefs(Array.isArray(entry.sourceRefs)?entry:{sourceRefs:[entry]},sourceUnits,label)})():sourceRefs({sourceUnitIds:value},sourceUnits,label);if(!selected.length)throw new DomainValidationError(`${label} 不得为空`);return selected},many=(value:unknown,count:number,label:string)=>{if(!Array.isArray(value)||value.length!==count)throw new DomainValidationError(`${label} 必须与对应字段逐项匹配：需要 ${count} 组，实际 ${Array.isArray(value)?value.length:'不是数组'} 组`);return value.map((entry,n)=>one(entry,`${label}[${n}]`))};requirement.evidenceBindings={behavior:one(binding.behavior,`${requirement.id}.evidenceBindings.behavior`),conditions:many(binding.conditions,requirement.conditions.length,`${requirement.id}.evidenceBindings.conditions`),constraints:many(binding.constraints,requirement.constraints.length,`${requirement.id}.evidenceBindings.constraints`),explicitAcceptanceConditions:many(binding.explicitAcceptanceConditions,requirement.explicitAcceptanceConditions.length,`${requirement.id}.evidenceBindings.explicitAcceptanceConditions`)}}
    else requirement.evidenceBindings={behavior:all,conditions:requirement.conditions.map(()=>all),constraints:requirement.constraints.map(()=>all),explicitAcceptanceConditions:requirement.explicitAcceptanceConditions.map(()=>all)};
    const bound=[...requirement.evidenceBindings.behavior,...requirement.evidenceBindings.conditions.flat(),...requirement.evidenceBindings.constraints.flat(),...requirement.evidenceBindings.explicitAcceptanceConditions.flat()];const derived=[...new Set(bound.map(ref=>ref.sourceUnitId))];if(derived.some(id=>!requirement.sourceUnitIds.includes(id)))throw new DomainValidationError(`${requirement.id}.evidenceBindings 超出需求来源范围`);return requirement});uniqueIds(requirements,'requirements');
  const normalize=(value:string)=>value.replace(/\s/g,'').toLocaleLowerCase('en-US');for(const requirement of requirements){const originals=sourceUnits.filter(unit=>requirement.sourceUnitIds.includes(unit.id)).map(unit=>normalize([unit.excerpt,unit.context??'',unit.asset?.extractedText??''].join('\n')));const splitExact=(condition:string)=>{if(originals.some(original=>original.includes(normalize(condition))))return[condition];const clauses=condition.split('；').map(value=>value.trim()).filter(Boolean),memo=new Map<number,string[]|undefined>();const visit=(start:number):string[]|undefined=>{if(start===clauses.length)return[];if(memo.has(start))return memo.get(start);for(let end=clauses.length;end>start;end--){const candidate=clauses.slice(start,end).join('；');if(!originals.some(original=>original.includes(normalize(candidate))))continue;const rest=visit(end);if(rest){const result=[candidate,...rest];memo.set(start,result);return result}}memo.set(start,undefined);return undefined};return clauses.length>1?visit(0):undefined};const accepted:string[]=[],unsupported:string[]=[];for(const condition of requirement.explicitAcceptanceConditions){const exact=splitExact(condition);exact?accepted.push(...exact):unsupported.push(condition)}if(unsupported.length)throw new DomainValidationError(`${requirement.id}.explicitAcceptanceConditions 必须逐字引用关联原文，不得推导或静默丢弃：${unsupported.join('；')}`);requirement.explicitAcceptanceConditions=accepted}
   const localIds=new Set(requirements.map(item=>item.id));const clarifications=questionsValue.map((raw,index)=>clarificationFrom(raw as Record<string,unknown>,index,sourceUnits,new Set([...sourceIds,...localIds])));uniqueIds(clarifications,'clarifications');return{requirements,clarifications};
}

export function validateDirectGraph(sourceUnits:SourceUnit[],dispositions:SourceDisposition[],features:Feature[],requirements:RequirementDetail[],clarifications:Clarification[]){
  if(sourceUnits.some(unit=>unit.status!=='processed'))throw new DomainValidationError('仍有未读取的原文单元');
  uniqueIds([...sourceUnits,...features,...requirements,...clarifications],'全局实体');
  acceptConstraintTargets(features.map(feature=>({...feature})),features);
  const sourceIds=new Set(sourceUnits.map(unit=>unit.id)),requirementIds=new Set(requirements.map(item=>item.id)),featureIds=new Set(features.map(item=>item.id));
  uniqueIds(dispositions.map(item=>({id:item.sourceUnitId})),'原文处置');
  for(const item of dispositions){refs([item.sourceUnitId],sourceIds,'sourceDispositions.sourceUnitId');if(!dispositionKinds.has(item.kind))throw new DomainValidationError(`${item.sourceUnitId} 原文处置分类非法`);text(item.reason,`${item.sourceUnitId}.reason`);refs(item.featureIds,featureIds,`${item.sourceUnitId}.featureIds`)}
  const disposed=new Set(dispositions.map(item=>item.sourceUnitId));const undisposed=sourceUnits.filter(unit=>!disposed.has(unit.id));if(undisposed.length)throw new DomainValidationError(`仍有未分类原文单元：${undisposed.slice(0,10).map(unit=>unit.id).join('、')}`);
  const owners=new Map<string,string>();
  for(const feature of features){refs(strings(feature.sourceUnitIds,`${feature.id}.sourceUnitIds`,false),sourceIds,`${feature.id}.sourceUnitIds`);const selected=sourceRefs({sourceRefs:feature.sourceRefs?.length?feature.sourceRefs:feature.sourceUnitIds.map(sourceUnitId=>({sourceUnitId}))},sourceUnits,feature.id),derived=new Set(selected.map(ref=>ref.sourceUnitId));if(feature.sourceUnitIds.some(id=>!derived.has(id))||derived.size!==new Set(feature.sourceUnitIds).size)throw new DomainValidationError(`${feature.id}.sourceUnitIds 必须由 sourceRefs 唯一派生`);refs(feature.requirementIds,requirementIds,`${feature.id}.requirementIds`);for(const id of feature.requirementIds){if(owners.has(id))throw new DomainValidationError(`${id} 必须有且仅有一个主所属功能，重复归属 ${owners.get(id)}、${feature.id}`);owners.set(id,feature.id)}}
  for(const requirement of requirements){refs(strings(requirement.sourceUnitIds,`${requirement.id}.sourceUnitIds`,false),sourceIds,`${requirement.id}.sourceUnitIds`);if(requirement.evidenceBindings){sourceRefs({sourceRefs:requirement.evidenceBindings.behavior},sourceUnits,`${requirement.id}.evidenceBindings.behavior`);for(const [field,groups] of [['conditions',requirement.evidenceBindings.conditions],['constraints',requirement.evidenceBindings.constraints],['explicitAcceptanceConditions',requirement.evidenceBindings.explicitAcceptanceConditions]] as const)for(const [index,selected] of groups.entries())sourceRefs({sourceRefs:selected},sourceUnits,`${requirement.id}.evidenceBindings.${field}[${index}]`)}if(!owners.has(requirement.id))throw new DomainValidationError(`${requirement.id} 没有主所属功能`)}
  for(const question of clarifications){refs(strings(question.affectedIds,`${question.id}.affectedIds`,false),new Set([...sourceIds,...requirementIds]),`${question.id}.affectedIds`);if(question.sourceRefs?.length)sourceRefs({sourceRefs:question.sourceRefs},sourceUnits,question.id)}
  const requirementById=new Map(requirements.map(item=>[item.id,item]));
  const detailed=new Set(requirements.flatMap(item=>item.sourceUnitIds)),questioned=new Set(clarifications.flatMap(item=>item.affectedIds.flatMap(id=>requirementById.get(id)?.sourceUnitIds??[id])));
  const uncovered=dispositions.filter(item=>(item.kind==='requirement'||item.kind==='clarification')&&!detailed.has(item.sourceUnitId)&&!questioned.has(item.sourceUnitId));return{uncovered};
}

export function acceptDirectAuditIssues(value:unknown,sourceUnits:SourceUnit[],features:Feature[],requirements:RequirementDetail[],clarifications:Clarification[],relations:RequirementRelation[]=[]){return acceptAuditIssues(value,sourceUnits,[],features,requirements,clarifications,relations)}

export function acceptRequirementRelations(value:unknown,sourceUnits:SourceUnit[],requirements:RequirementDetail[]):RequirementRelation[]{
  if(value===undefined)return[];if(!Array.isArray(value))throw new DomainValidationError('relations 必须是数组');const ids=new Set(requirements.map(item=>item.id)),kinds=new Set(['depends-on','affects','exception-to']);
  const relations=value.map((raw,index)=>{if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new DomainValidationError(`relations[${index}] 必须是对象`);const item=raw as Record<string,unknown>,sourceRequirementId=text(item.sourceRequirementId,`relations[${index}].sourceRequirementId`),targetRequirementId=text(item.targetRequirementId,`relations[${index}].targetRequirementId`),kind=text(item.kind,`relations[${index}].kind`);refs([sourceRequirementId,targetRequirementId],ids,`relations[${index}]`);if(sourceRequirementId===targetRequirementId)throw new DomainValidationError('需求关系禁止自引用');if(!kinds.has(kind))throw new DomainValidationError(`relations[${index}].kind 非法`);const selected=sourceRefs(item,sourceUnits,`relations[${index}]`);return{id:typeof item.id==='string'&&item.id.trim()?item.id.trim():`LOCAL-REL-${index+1}`,sourceRequirementId,targetRequirementId,kind:kind as RequirementRelation['kind'],sourceRefs:selected}});
  uniqueIds(relations,'relations');return relations;
}
