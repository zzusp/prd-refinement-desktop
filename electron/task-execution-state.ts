import {createHash} from 'node:crypto';
import type {AnalysisCheckRecord,AuditIssue,PrdProject,RequiredCheckId} from '../src/types.js';
import {classifyIssues} from './audit-repair.js';

const ordered=(values:string[])=>[...new Set(values)].sort();
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalizedType=(value:string)=>value.replace(/[\s，。；：、,.!?！？:;]/g,'').toLocaleLowerCase('zh-CN');

export function issueIdentity(issue:AuditIssue){
  return hash([issue.category??'',issue.owner??'',issue.direction,normalizedType(issue.type),ordered(issue.sourceUnitIds),ordered(issue.affectedIds)]);
}
export function issueId(identityKey:string){return `A-${identityKey.slice(0,12).toUpperCase()}`}
export function projectDependencyHash(project:PrdProject,entityIds:string[],sourceIds:string[],includeCatalog=false){
  const ids=new Set(entityIds),sources=new Set(sourceIds);
  return hash({sourceHash:project.sourceHash,revision:project.revision,sources:project.sourceUnits.filter(x=>sources.has(x.id)),features:project.features.filter(x=>ids.has(x.id)),requirements:project.requirements.filter(x=>ids.has(x.id)),clarifications:project.clarifications.filter(x=>ids.has(x.id)),relations:(project.relations??[]).filter(x=>ids.has(x.id)||ids.has(x.sourceRequirementId)||ids.has(x.targetRequirementId)),...(includeCatalog?{requirementCatalog:project.requirements.map(x=>[x.id,x.sourceRefs])}:{})});
}
export function registerAuditIssues(existing:AuditIssue[],incoming:AuditIssue[],project:PrdProject){
  const registry=new Map(existing.map(item=>[item.identityKey??issueIdentity(item),item]));
  for(const observation of classifyIssues(incoming,project)){
    const identityKey=issueIdentity(observation),dependencyHash=projectDependencyHash(project,observation.affectedIds,observation.sourceUnitIds,true),found=registry.get(identityKey);
    if(found){found.detail=observation.detail;found.dependencyHash=dependencyHash;if(found.closedDependencyHash&&found.closedDependencyHash!==dependencyHash)found.disposition=found.category==='source-ambiguity'?'needs-confirmation':'open';continue}
    const created={...observation,id:issueId(identityKey),identityKey,dependencyHash};existing.push(created);registry.set(identityKey,created);
  }
  return existing;
}
export function closeIssue(issue:AuditIssue,disposition:'repaired'|'dismissed'){
  issue.disposition=disposition;issue.closedDependencyHash=issue.dependencyHash;
}
export function contentFingerprint(project:PrdProject){return hash({features:project.features,requirements:project.requirements,relations:project.relations??[],clarifications:project.clarifications,sourceDispositions:project.sourceDispositions??[]})}
export function projectInputHash(project:PrdProject){return hash({sourceHash:project.sourceHash,materialBundle:project.materialBundle,analysisInputFingerprint:project.analysisInput?.fingerprint??null})}
export function sourceCoverageDecisionValid(project:PrdProject,sourceUnitId:string,decision:NonNullable<NonNullable<import('../src/types.js').AnalysisTask['checkpoint']>['sourceCoverageDecisions']>[string]){
  return decision.requirementIds.length>0&&decision.requirementIds.every(id=>project.requirements.some(item=>item.id===id))&&decision.dependencyHash===projectDependencyHash(project,decision.requirementIds,[sourceUnitId],false);
}
export function invalidateSourceCoverageDecisions(project:PrdProject,issues:AuditIssue[],decisions:NonNullable<NonNullable<import('../src/types.js').AnalysisTask['checkpoint']>['sourceCoverageDecisions']>){
  const reopened:string[]=[];
  for(const [sourceUnitId,decision] of Object.entries(decisions))if(!sourceCoverageDecisionValid(project,sourceUnitId,decision)){
    delete decisions[sourceUnitId];const issue=issues.find(item=>item.id===decision.issueId);if(!issue)continue;
    issue.disposition='open';issue.dependencyHash=projectDependencyHash(project,issue.affectedIds,issue.sourceUnitIds,true);delete issue.closedDependencyHash;reopened.push(issue.id);
  }
  return reopened;
}
export function requiredChecks(project:PrdProject,resultVersion:number):Record<RequiredCheckId,AnalysisCheckRecord>{
  const now=Date.now(),base={resultVersion,checkedAt:now,issueIds:[] as string[]};
  const dependencyHash=contentFingerprint(project);
  return {source:{id:'source',status:project.sourceUnits.every(x=>x.status==='processed')?'passed':'failed',dependencyHash,...base},feature:{id:'feature',status:'unknown',dependencyHash,...base},detail:{id:'detail',status:'unknown',dependencyHash,...base},relation:{id:'relation',status:'unknown',dependencyHash,...base}};
}
export function checksPass(checks:Partial<Record<RequiredCheckId,AnalysisCheckRecord>>|undefined,resultVersion:number){
  return (['source','feature','detail','relation'] as RequiredCheckId[]).every(id=>checks?.[id]?.status==='passed'&&checks[id]?.resultVersion===resultVersion);
}
