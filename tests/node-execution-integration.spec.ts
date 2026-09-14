import {afterAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {AnalysisTaskScheduler} from '../electron/scheduler-v2';
import {RuntimeOperationError,type AnalysisRuntime} from '../electron/runtime';
import {executeNode} from '../electron/node-executor';
import {acceptFeatureUnification} from '../electron/domain';
import {buildEvidenceCatalog,materializeEvidenceSelections} from '../electron/source-evidence';
import {z} from 'zod';
import type {PrdProject,RuntimeConfig,NodeExecutionReceipt,Feature,SourceUnit} from '../src/types';

const root=path.resolve('docs/tmp/test-run/vitest/node-execution-integration',randomUUID());
afterAll(()=>rm(root,{recursive:true,force:true}));
const config:RuntimeConfig={adapter:'codex-oauth',provider:'fake',model:'model',reasoningEffort:'low',maxParallel:1,maxNodeParallel:1};
const project=():PrdProject=>({id:'P',name:'边界验收',sourceName:'test.md',sourceHash:'H',revision:1,importedAt:'now',rawText:'用户必须填写名称。重复名称是否允许需要业务确认。',stage:'inventory',sourceUnits:[],features:[],requirements:[],clarifications:[]});
async function projectWithSnapshot(directory:string){const value=project(),snapshot=path.join(directory,'input-snapshots','P'),input=path.join(snapshot,'input');await mkdir(input,{recursive:true});await writeFile(path.join(input,'test.md'),value.rawText,'utf8');value.inputSnapshotPath=snapshot;return value}
async function terminal(scheduler:AnalysisTaskScheduler){for(let i=0;i<400;i++){const value=scheduler.list()[0],running=(scheduler as unknown as {running:Map<string,unknown>}).running.size;if(value&&!running&&['completed','failed','needs-attention'].includes(value.status))return value;await new Promise(resolve=>setTimeout(resolve,10))}throw new Error('超时')}
function runtime(mode:'question'|'repair-failure',calls:string[]):AnalysisRuntime{return {
 start:async()=>{},stop:async()=>{},diagnostics:()=>'',promptAndWait:async()=>{throw new Error('不得走普通文本')},
 async executeOperation(request){
  const node=request.submission.name;calls.push(node);const input=(request.input as any).previousCandidate?(request.input as any).input:request.input as any;let value:any;
  if(node==='submit_candidates')value={features:[{id:'LF',name:'名称维护',kind:'function',appliesToFeatureIds:[],evidenceIds:input.evidenceCatalog.map((e:any)=>e.id)}],sourceDispositions:input.sourceUnits.map((u:any)=>({sourceUnitId:u.id,contentRole:'requirement',reason:'原文明示',featureIds:['LF']}))};
  else if(node==='submit_unify')value={features:input.candidates.map((f:any)=>({id:f.id,name:f.name,kind:f.kind,appliesToFeatureIds:[]})),candidateMappings:input.candidates.map((f:any)=>({candidateId:f.id,featureIds:[f.id]}))};
  else if(node==='submit_details')value={requirements:[{id:'LR',text:'用户必须填写名称',evidenceIds:[input.evidenceCatalog[0].id]}],clarifications:mode==='question'?[{id:'LQ',level:'blocking',question:'是否允许重复名称？',reason:'原文要求确认',knownFacts:'名称必须填写',unresolvedPoint:'重复名称规则未明确',impact:'决定保存行为',levelReason:'保存规则必须确定',affectedIds:['LR'],evidenceIds:[input.evidenceCatalog.at(-1).id],resolutionProposal:{recommendation:'建议由业务明确是否允许名称重复后再实施保存校验',rationale:'避免自行确定未明确规则',impact:'影响保存校验',confirmation:'请确认是否允许名称重复',alternatives:[],evidenceIds:[input.evidenceCatalog.at(-1).id]}}]:[]};
  else if(node==='submit_audit')value={issues:mode==='repair-failure'?[{id:'AI1',direction:'reverse',type:'条件缺失',sourceUnitIds:input.sourceUnits.map((u:any)=>u.id),affectedIds:[input.requirements[0].id],detail:'名称保存条件存在缺失',owner:'requirement-detail',category:'detail-mismatch'}]:[],relations:[]};
  else if(node==='submit_repair')throw new RuntimeOperationError('authentication','测试认证故障');
  else throw new Error(`未知测试节点 ${node}`);
  return {value,completion:'completed'};
 },
};}
describe('节点执行与交付边界集成',()=>{
 it('同workitem不同输入使用独立operationId，onAttempt记录真实调用标识',async()=>{
  const schema=z.strictObject({text:z.string()}),receipts:Record<string,NodeExecutionReceipt>={},called:string[]=[],observed:string[]=[];
  const node={id:'unify',version:1,input:schema,proposal:schema,result:schema,parameters:{type:'object'},instructions:'提交',accept:(value:Record<string,unknown>)=>value};
  const runtime={executeOperation:async(request:{operationId:string;input:unknown})=>{called.push(request.operationId);return{completion:'completed',value:request.input}}} as unknown as AnalysisRuntime;
  const common={workItemId:'unify',executionId:'attempt1',configuration:{},receipts,assert:()=>{},runtime:async()=>runtime,save:async()=>{},onAttempt:async(_attempt:number,_request:string,id:string)=>{observed.push(id)}};
  await Promise.all(['候选组甲','候选组乙'].map(text=>executeNode(node,{...common,input:{text}})));
  expect(called).toHaveLength(2);expect(new Set(called).size).toBe(2);expect(observed.sort()).toEqual(called.sort());expect(called.every(id=>/^attempt1-unify-[0-9a-f]{16}-try1$/.test(id))).toBe(true);expect(Object.keys(receipts)).toHaveLength(2);
 });
 it('单目标映射携带allocations必须拒绝，不能静默忽略证据选择',()=>{
  const units:SourceUnit[]=[{id:'S1',label:'名称',kind:'paragraph',excerpt:'名称必须填写。',location:'第1段',status:'processed'}],catalog=buildEvidenceCatalog(units);
  const candidates:Feature[]=[{id:'C1',name:'名称维护',kind:'function',sourceUnitIds:['S1'],sourceRefs:[{sourceUnitId:'S1'}],ruleIds:[],requirementIds:[],state:'draft'}];
  const raw={features:[{id:'F1',name:'名称维护',kind:'function',appliesToFeatureIds:[]}],candidateMappings:[{candidateId:'C1',featureIds:['F1'],allocations:[{featureId:'OTHER',evidenceIds:[catalog[0].id]}]}]};
  expect(()=>acceptFeatureUnification(materializeEvidenceSelections(raw,catalog),candidates,units)).toThrow('单目标映射由平台继承完整来源');
 });
 it.each([false,true])('同workitem并发不能读取未落盘的成功候选，写盘故障=%s',async(failWrite)=>{
  let release!:()=>void,entered!:()=>void,calls=0,secondSettled=false;const saved=new Promise<void>(resolve=>{release=resolve}),saving=new Promise<void>(resolve=>{entered=resolve});
  const schema=z.strictObject({text:z.string()}),receipts:Record<string,NodeExecutionReceipt>={},node={id:'concurrency',version:1,input:schema,proposal:schema,result:schema,parameters:{type:'object'},instructions:'提交',accept:(value:Record<string,unknown>)=>value};
  const options={workItemId:'batch1',executionId:'attempt1',input:{text:'输入'},configuration:{},receipts,assert:()=>{},runtime:async()=>({executeOperation:async()=>{calls++;return{completion:'completed',value:{text:'正式结果'}}}} as unknown as AnalysisRuntime),save:async()=>{if(Object.values(receipts).some(item=>item.status==='succeeded')){entered();await saved;if(failWrite)throw new Error('磁盘写入失败')}}};
  const first=executeNode(node,options).then(value=>({ok:true,value}),error=>({ok:false,error}));await saving;
  const second=executeNode(node,options).then(value=>{secondSettled=true;return{ok:true,value}},error=>{secondSettled=true;return{ok:false,error}});
  for(let i=0;i<10;i++)await Promise.resolve();const settledBeforeCommit=secondSettled;release();const outcomes=await Promise.all([first,second]);
  expect(settledBeforeCommit).toBe(false);expect(calls).toBe(1);expect(outcomes.map(result=>result.ok)).toEqual(failWrite?[false,false]:[true,true]);
  if(failWrite)expect(Object.values(receipts).some(item=>item.status==='succeeded')).toBe(false);
 });
 it('合法阻塞级业务澄清进入需求包，不成为平台失败',async()=>{
  const calls:string[]=[],directory=path.join(root,'questions'),scheduler=new AnalysisTaskScheduler(directory,async()=>config,()=>{},()=>runtime('question',calls));await scheduler.initialize();await scheduler.create(await projectWithSnapshot(directory));const done=await terminal(scheduler);
  expect(done.status,done.error).toBe('completed');expect(done.project.delivery?.state).toBe('ready');expect(done.project.clarifications).toHaveLength(1);expect(done.project.clarifications[0]).toMatchObject({level:'blocking',state:'open'});expect(done.checkpoint?.executionFailures??[]).toEqual([]);expect(done.artifacts?.at(-1)?.kind).toBe('agent-package');
 });
 it('修正通道故障保留原AuditIssue且不提交补丁或正式包',async()=>{
  const calls:string[]=[],directory=path.join(root,'repair-failure'),scheduler=new AnalysisTaskScheduler(directory,async()=>config,()=>{},()=>runtime('repair-failure',calls));await scheduler.initialize();const created=await scheduler.create(project()),done=await terminal(scheduler);
  expect(done.status,done.error).toBe('failed');expect(calls.filter(node=>node==='submit_repair')).toHaveLength(1);expect(done.checkpoint?.auditIssues).toHaveLength(1);expect(done.checkpoint?.auditIssues[0].detail).toBe('名称保存条件存在缺失');expect(done.checkpoint?.executionFailures).toMatchObject([{node:'repair',message:'测试认证故障'}]);expect(done.artifacts??[]).toEqual([]);
  const persisted=JSON.parse(await readFile(path.join(directory,`${created.id}.json`),'utf8'));expect(persisted.checkpoint.auditIssues[0].detail).not.toContain('认证');expect(persisted.project.requirements[0].text).toBe('用户必须填写名称');
 });
});
