import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisTask, DeliveryAssessment, PrdProject, RequirementDetail } from '../src/types.js';
import { featureTitle, readableContext, requirementSourceRefs, requirementText } from '../src/result-presentation.js';
import { projectInputHash } from './task-execution-state.js';

type DeliveryState = DeliveryAssessment['state'];
type ExtendedTask = AnalysisTask & { runId?:string };
const agentPackageSchemaVersion = 8 as const;

export interface AgentPackageManifest {
  schemaVersion: 8;
  deliveryId: string;
  taskId: string;
  runId?: string;
  attempt: number;
  materialBundle?: {id:string;revision:number};
  inputHash: string;
  resultHash: string;
  qualityState: DeliveryState;
  runtimeConfig?: AnalysisTask['runtimeConfig'];
  policyVersion: number;
  resultVersion?: number;
  selectedFeatureIds: string[];
  qualityBoundary: 'evidence-checked-prd-checklist';
  files: Array<{path:string;sha256:string;size:number}>;
}

export interface AgentPackageResult { directory:string; manifest:AgentPackageManifest }
export interface AgentPackageScope { selectedFeatureIds?: string[] }
interface DeliveryScope { selectedFeatureIds:string[]; project:PrdProject }

const json = (value:unknown) => JSON.stringify(value,null,2)+'\n';
const sha256 = (value:string|Buffer) => createHash('sha256').update(value).digest('hex');
const safeSegment = (value:string,label:string) => {if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value))throw new Error(`${label}包含不安全字符`);return value};

export function packageQuality(task:AnalysisTask,project:PrdProject):DeliveryAssessment {
  const active=(project.audit?.issues??[]).filter(issue=>issue.disposition!=='repaired'&&issue.disposition!=='dismissed');
  const assessment=structuredClone(project.delivery??{state:'unchecked',inputHash:projectInputHash(project),resultHash:'',issueIds:[],unverifiedScopeIds:[],policyVersion:2}) as DeliveryAssessment;
  if(task.status==='failed'||active.length){assessment.state='blocked';assessment.issueIds=[...new Set([...assessment.issueIds,...active.map(item=>item.id)])];return assessment}
  if(task.status!=='completed'||project.audit?.passed!==true||assessment.unverifiedScopeIds.length){assessment.state='unchecked';return assessment}
  if(!project.delivery)assessment.state='ready';
  return assessment;
}

function deliveryScope(project:PrdProject,requested?:AgentPackageScope):DeliveryScope {
  const business=project.features.filter(item=>item.kind!=='constraint');
  const known=new Set(business.map(item=>item.id));
  const requestedIds=requested?.selectedFeatureIds;
  if(requestedIds&&new Set(requestedIds).size!==requestedIds.length)throw new Error('交付范围包含重复功能');
  const unknown=(requestedIds??[]).filter(id=>!known.has(id));
  if(unknown.length)throw new Error(`交付范围包含不存在或不可单独交付的功能：${unknown.join('、')}`);
  // 本期范围是结果的一部分，导出时按持久化的范围决定筛选。
  // selectedFeatureIds 仅保留旧调用的参数校验；旧结果没有 deliveryScope 时全部视为本期。
  const requirementById=new Map(project.requirements.map(item=>[item.id,item]));
  const includedRequirementIds=new Set<string>();
  const includedBusiness=business.filter(feature=>{
    if(feature.deliveryScope==='excluded')return false;
    for(const id of feature.requirementIds){const requirement=requirementById.get(id);if(requirement&&requirement.deliveryScope!=='excluded')includedRequirementIds.add(id)}
    return feature.requirementIds.some(id=>includedRequirementIds.has(id));
  });
  const selected=includedBusiness.map(item=>item.id),selectedSet=new Set(selected);
  const includedConstraints=project.features.filter(item=>item.kind==='constraint'&&item.deliveryScope!=='excluded'&&(item.appliesToFeatureIds??[]).some(id=>selectedSet.has(id))).map(feature=>{
    for(const id of feature.requirementIds){const requirement=requirementById.get(id);if(requirement&&requirement.deliveryScope!=='excluded')includedRequirementIds.add(id)}
    return feature;
  }).filter(feature=>feature.requirementIds.some(id=>includedRequirementIds.has(id)));
  if(!includedRequirementIds.size)throw new Error('本期范围没有可交付需求，请先调整需求范围');
  const includedFeatures=[...includedBusiness,...includedConstraints].map(feature=>({...structuredClone(feature),requirementIds:feature.requirementIds.filter(id=>includedRequirementIds.has(id)),appliesToFeatureIds:feature.appliesToFeatureIds?.filter(id=>selectedSet.has(id))}));
  const includedRequirements=project.requirements.filter(item=>includedRequirementIds.has(item.id));
  const scoped:PrdProject={...structuredClone(project),features:includedFeatures,requirements:includedRequirements};
  return {selectedFeatureIds:selected,project:scoped};
}

function snapshot(project:PrdProject,task:ExtendedTask,assessment:DeliveryAssessment,scope:Pick<DeliveryScope,'selectedFeatureIds'>) {
  return {
    schemaVersion:2,
    project:{id:project.id,name:project.name,revision:project.revision,sourceName:project.sourceName,sourceHash:project.sourceHash,materialBundle:project.materialBundle},
    task:{id:task.id,runId:task.runId,attempt:task.attempt,resultVersion:(task as AnalysisTask&{resultVersion?:number}).resultVersion},
    delivery:{state:assessment.state,inputHash:assessment.inputHash,policyVersion:assessment.policyVersion,...scope},
    features:project.features.map(feature=>({id:feature.id,name:featureTitle(project,feature),sourceRefs:feature.sourceRefs?.length?feature.sourceRefs:feature.sourceUnitIds.map(sourceUnitId=>({sourceUnitId})),requirementIds:feature.requirementIds})),
    requirements:project.requirements.map(requirement=>({id:requirement.id,featureId:requirement.featureId,text:requirementText(requirement),sourceRefs:requirementSourceRefs(requirement)})),
    sources:project.sourceUnits.map(({id,fileId,fileRevision,logicalPath,sourceRole,label,kind,excerpt,location,asset})=>({id,fileId,fileRevision,logicalPath,sourceRole,label,kind,excerpt,location,asset:asset?{mimeType:asset.mimeType,sha256:asset.sha256,path:`sources/assets/${asset.sha256}${path.extname(asset.path).toLowerCase()}`}:undefined}))
  };
}

const checklistText = (value:string) => value.replace(/\r?\n/g,'<br>').trim();
const markdownLabel = (value:string) => value.replace(/([\\[\]])/g,'\\$1');
const markdownPath = (value:string) => value.split('/').map(encodeURIComponent).join('/');
interface ChecklistSource { key:string; text:string }
const sourceSetKey = (items:ChecklistSource[]) => JSON.stringify(items.map(item=>item.key).sort());
function checklistSources(project:PrdProject) {
  const referenced=new Set(project.requirements.flatMap(requirement=>requirementSourceRefs(requirement).map(ref=>ref.sourceUnitId)));
  const paths=[...new Set(project.sourceUnits.filter(unit=>referenced.has(unit.id)).map(unit=>unit.logicalPath??project.sourceName))];
  const primaryPath=project.sourceDocuments?.find(document=>document.role==='primary')?.logicalPath??project.sourceName;
  const aliases=new Map(paths.map((logical,index)=>[logical,paths.length===1||logical===primaryPath?'主 PRD':`原文 ${index+1}`]));
  const files=paths.map(logical=>`${aliases.get(logical)}：[${markdownLabel(logical)}](${markdownPath(`sources/files/${logical}`)})`);
  const source=(ref:ReturnType<typeof requirementSourceRefs>[number]):ChecklistSource=>{
    const unit=project.sourceUnits.find(item=>item.id===ref.sourceUnitId);if(!unit)throw new Error(`来源不存在：${ref.sourceUnitId}`);
    const logical=unit.logicalPath??project.sourceName,alias=aliases.get(logical)??logical;
    const rawPath=readableContext(unit.context).match(/章节路径：([^\n]+)/)?.[1];
    const headingKey=rawPath?.split('→').map(value=>value.trim()).filter(Boolean).join(' → ');
    const heading=headingKey?.replace(/\[S-[^\]]+\]\s*/g,'').trim();
    const position=heading||unit.location;
    return{key:JSON.stringify([logical,headingKey||unit.location]),text:`${alias} · ${position}`};
  };
  return{files,source};
}
function implementationMarkdown(project:PrdProject) {
  const requirements=new Map(project.requirements.map(item=>[item.id,item])),seen=new Set<string>();
  const sources=checklistSources(project);
  const sections=[`# ${checklistText(project.name)} · 需求检查清单`,'', '> 先阅读原始 PRD，再用本清单查漏；完成后勾选。','',...sources.files];
  for(const feature of project.features){
    const own=feature.requirementIds.map(id=>requirements.get(id)).filter((item):item is RequirementDetail=>!!item);
    if(!own.length)continue;
    sections.push('',`## ${feature.id} ${checklistText(featureTitle(project,feature))}`,'');
    if(feature.kind==='constraint'&&feature.appliesToFeatureIds?.length)sections.push(`适用模块：${feature.appliesToFeatureIds.join('、')}`,'');
    const locations=own.map(requirement=>{
      const refs=requirementSourceRefs(requirement);if(!refs.length)throw new Error(`需求缺少原文：${requirement.id}`);
      const unique=new Map<string,ChecklistSource>();for(const ref of refs){const value=sources.source(ref);unique.set(value.key,value)}
      return [...unique.values()];
    });
    const counts=new Map<string,{count:number;first:number;items:ChecklistSource[]}>();
    locations.forEach((items,index)=>{const key=sourceSetKey(items);const value=counts.get(key);if(value)value.count++;else counts.set(key,{count:1,first:index,items})});
    const shared=[...counts.values()].filter(value=>value.count>=2).sort((a,b)=>b.count-a.count||a.first-b.first)[0];
    const defaultKey=shared&&sourceSetKey(shared.items);
    if(shared)sections.push(`默认原文：${shared.items.map(item=>item.text).join('；')}`,'');
    for(const [index,requirement] of own.entries()){
      if(seen.has(requirement.id))throw new Error(`重复需求编号：${requirement.id}`);seen.add(requirement.id);
      sections.push(`- [ ] ${requirement.id}：${checklistText(requirementText(requirement))}`);
      const items=locations[index],key=sourceSetKey(items);
      if(key!==defaultKey)sections.push(`  - 原文：${items.map(item=>item.text).join('；')}`);
    }
  }
  if(seen.size!==project.requirements.length)throw new Error('存在未进入实施清单的需求');
  return sections.join('\n')+'\n';
}

async function verifyPackage(directory:string,manifest:AgentPackageManifest,expectedIds:string[],expectedImplementation:string) {
  const actualImplementation=await readFile(path.join(directory,'agent-checklist.md'),'utf8');
  if(actualImplementation!==expectedImplementation)throw new Error('agent-checklist.md 回读内容不一致');
  const ids=[...actualImplementation.matchAll(/^- \[ \] ([A-Za-z0-9._-]+)：/gm)].map(match=>match[1]).sort();
  if(JSON.stringify(ids)!==JSON.stringify([...expectedIds].sort()))throw new Error('agent-checklist.md 回读需求不一致');
  for(const file of manifest.files){const full=path.join(directory,...file.path.split('/'));const data=await readFile(full);if(data.length!==file.size||sha256(data)!==file.sha256)throw new Error(`文件回读校验失败：${file.path}`)}
}
async function relativeFiles(root:string,current=root):Promise<string[]>{const out:string[]=[];for(const entry of await readdir(current,{withFileTypes:true})){const full=path.join(current,entry.name);if(entry.isSymbolicLink())throw new Error('原始资料不允许符号链接');if(entry.isDirectory())out.push(...await relativeFiles(root,full));else if(entry.isFile())out.push(path.relative(root,full).split(path.sep).join('/'))}return out}
async function publishDirectory(source:string,target:string){
  try { await rename(source,target); return; }
  catch(error) {
    const code=(error as NodeJS.ErrnoException).code;
    if(!['EPERM','EACCES','EBUSY'].includes(code??''))throw error;
  }
  await cp(source,target,{recursive:true,errorOnExist:true,force:false});
  await rm(source,{recursive:true,force:true});
}

/** 从同一需求快照确定性编译文件，独立回读通过后发布到唯一目录。 */
export async function writeAgentPackage(project:PrdProject,task:AnalysisTask,outputRoot:string,requestedDeliveryId?:string,requestedScope?:AgentPackageScope):Promise<AgentPackageResult> {
  const extendedTask=task as ExtendedTask,scope=deliveryScope(project,requestedScope),extendedProject=scope.project;
  const assessment=packageQuality(task,project),scopeRecord={selectedFeatureIds:scope.selectedFeatureIds};
  const packageFingerprint=(resolved:DeliveryScope,resolvedAssessment:DeliveryAssessment)=>sha256(json({schemaVersion:agentPackageSchemaVersion,requirements:snapshot(resolved.project,extendedTask,resolvedAssessment,{selectedFeatureIds:resolved.selectedFeatureIds})}));
  const beforeAttempt=task.attempt,beforeFingerprint=packageFingerprint(scope,assessment);
  const deliveryId=safeSegment(requestedDeliveryId??`${task.id}-a${task.attempt}-${beforeFingerprint.slice(0,12)}`,'交付编号');
  const finalDirectory=path.join(outputRoot,deliveryId),temporaryDirectory=path.join(outputRoot,`.${deliveryId}.${randomUUID()}.tmp`);
  await mkdir(outputRoot,{recursive:true});await mkdir(temporaryDirectory,{recursive:true});
  try {
    const implementation=implementationMarkdown(extendedProject);
    const resultHash=sha256(implementation);
    await writeFile(path.join(temporaryDirectory,'agent-checklist.md'),implementation,'utf8');
    await writeFile(path.join(temporaryDirectory,'README.md'),[
      `# ${project.name} 需求检查包`,'',
      '1. 先阅读 `sources/files/` 中的原始 PRD 与相关资料。',
      '2. 结合目标代码仓库逐项实现 `agent-checklist.md` 中的需求。',
      '3. 每完成一项，将对应的 `- [ ]` 改为 `- [x]`。','',
      '> `agent-checklist.md` 只用于查漏，不能替代原始 PRD；勾选表示已结合原文检查该项。',''
    ].join('\n'),'utf8');
    const sourceRoot=path.join(temporaryDirectory,'sources');await mkdir(sourceRoot,{recursive:true});
    if(!project.inputSnapshotPath)throw new Error('缺少冻结原始资料，不能导出交付包');
    const input=path.join(project.inputSnapshotPath,'input');
    if(!(await stat(input)).isDirectory())throw new Error('冻结原始资料目录不存在');
    const originals=await relativeFiles(input);
    const expectedOriginals=new Set([...(project.sourceDocuments??[]).map(document=>document.logicalPath),...project.sourceUnits.map(unit=>unit.logicalPath??project.sourceName)]);
    for(const expected of expectedOriginals)if(!originals.includes(expected))throw new Error(`冻结原始文件缺失：${expected}`);
    if(!originals.length)throw new Error('冻结原始资料为空');
    const originalHashes=new Map(await Promise.all(originals.map(async relative=>[relative,sha256(await readFile(path.join(input,...relative.split('/'))))] as const)));
    await cp(input,path.join(sourceRoot,'files'),{recursive:true,errorOnExist:true,force:false});
    for(const [relative,hash] of originalHashes)if(sha256(await readFile(path.join(sourceRoot,'files',...relative.split('/'))))!==hash)throw new Error(`原始文件复制校验失败：${relative}`);
    const outputFiles=await relativeFiles(temporaryDirectory);
    const files=[] as AgentPackageManifest['files'];
    for(const relative of outputFiles){if(relative==='manifest.json')continue;const data=await readFile(path.join(temporaryDirectory,...relative.split('/')));files.push({path:relative,sha256:sha256(data),size:data.length})}
    const manifest:AgentPackageManifest={schemaVersion:agentPackageSchemaVersion,deliveryId,taskId:task.id,runId:extendedTask.runId,attempt:task.attempt,materialBundle:project.materialBundle,inputHash:assessment.inputHash,resultHash,qualityState:assessment.state,runtimeConfig:task.runtimeConfig,policyVersion:assessment.policyVersion,resultVersion:(task as AnalysisTask&{resultVersion?:number}).resultVersion,...scopeRecord,qualityBoundary:'evidence-checked-prd-checklist',files};
    await writeFile(path.join(temporaryDirectory,'manifest.json'),json(manifest),'utf8');
    await verifyPackage(temporaryDirectory,manifest,extendedProject.requirements.map(item=>item.id),implementation);
    const manifestReadback=JSON.parse(await readFile(path.join(temporaryDirectory,'manifest.json'),'utf8')) as AgentPackageManifest;
    if(JSON.stringify(manifestReadback)!==JSON.stringify(manifest))throw new Error('manifest.json 回读内容不一致');
    const currentScope=deliveryScope(project,requestedScope),currentAssessment=packageQuality(task,project);
    if(task.attempt!==beforeAttempt||packageFingerprint(currentScope,currentAssessment)!==beforeFingerprint)throw new Error('导出期间任务或需求数据已变化');
    await publishDirectory(temporaryDirectory,finalDirectory);
    return {directory:finalDirectory,manifest};
  } catch(error) {
    await rm(temporaryDirectory,{recursive:true,force:true});throw error;
  }
}

export async function listPublishedPackageFiles(directory:string){return (await readdir(directory,{recursive:true})).map(String).sort()}
