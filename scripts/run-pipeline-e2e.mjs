import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AnalysisTaskScheduler } from '../docs/tmp/desktop-build/current/dist-electron/electron/scheduler-v2.js';

const source=process.argv[2],root=process.argv[3]??path.resolve('docs/tmp/e2e-pipeline/current'),retryId=process.argv[4];
if(!source)throw new Error('用法：node scripts/run-pipeline-e2e.mjs <PRD路径> [任务目录]');
const rawText=await readFile(source,'utf8');
const inputSnapshotPath=path.resolve(root,'input-snapshots',createHash('sha256').update(rawText).digest('hex'));
await mkdir(path.join(inputSnapshotPath,'input'),{recursive:true});
await copyFile(source,path.join(inputSnapshotPath,'input',path.basename(source)));
const config={adapter:'codex-oauth',provider:'openai-codex',fastModel:'gpt-5.6-luna',fastReasoningEffort:'low',model:'gpt-5.6-sol',reasoningEffort:'low',nodeProfiles:{imageReading:{model:'gpt-5.6-sol',reasoningEffort:'low'},featureCandidates:{model:'gpt-5.6-luna',reasoningEffort:'low'},featureCandidateRepair:{model:'gpt-5.6-sol',reasoningEffort:'low'},featureGlobal:{model:'gpt-5.6-sol',reasoningEffort:'low'},detailsFast:{model:'gpt-5.6-luna',reasoningEffort:'low'},details:{model:'gpt-5.6-sol',reasoningEffort:'low'},audit:{model:'gpt-5.6-sol',reasoningEffort:'low'},repair:{model:'gpt-5.6-sol',reasoningEffort:'low'}},maxParallel:1,maxNodeParallel:10};
let signature='';
const scheduler=new AnalysisTaskScheduler(root,async()=>config,task=>{const step=task.steps.find(x=>x.status==='running')?.name??task.status,next=task.runtimeMetrics?.length??0,current=step+'|'+next;if(current!==signature){signature=current;console.log(new Date().toISOString(),task.status,task.progress,step,'calls='+next)}});
await scheduler.initialize();
const project={id:'P-ILCD-V2',name:'ILCD合规字段调整-过程管理',sourceName:path.basename(source),inputSnapshotPath,sourceHash:createHash('sha256').update(rawText).digest('hex'),revision:1,importedAt:new Date().toISOString(),rawText,stage:'imported',sourceUnits:[],rules:[],features:[],requirements:[],clarifications:[]};
const created=retryId?(await scheduler.retry(retryId),scheduler.list().find(x=>x.id===retryId)):await scheduler.create(project);
if(!created)throw new Error('找不到待重试任务 '+retryId);
while(true){const task=scheduler.list().find(x=>x.id===created.id);if(task&&['completed','needs-attention','failed'].includes(task.status)&&!scheduler.running.size){console.log(JSON.stringify({id:task.id,status:task.status,error:task.error,features:task.project.features.length,requirements:task.project.requirements.length,clarifications:task.project.clarifications.length,issues:task.project.audit?.issues.length??0,steps:task.steps.map(x=>({name:x.name,runs:x.runs??0,durationMs:x.durationMs??((x.completedAt??Date.now())-(x.startedAt??Date.now()))})),metrics:{calls:task.runtimeMetrics?.length??0,inputTokens:task.runtimeMetrics?.reduce((s,x)=>s+(x.inputTokens??0),0)??0,cachedInputTokens:task.runtimeMetrics?.reduce((s,x)=>s+(x.cachedInputTokens??0),0)??0,outputTokens:task.runtimeMetrics?.reduce((s,x)=>s+(x.outputTokens??0),0)??0}},null,2));process.exit(task.status==='completed'?0:1)}await new Promise(resolve=>setTimeout(resolve,1000))}
