import {afterAll,describe,expect,it} from 'vitest';
import {readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AnalysisTaskScheduler,attachInitialUserInput,compactPromptInput,schedulerConcurrency} from '../electron/scheduler-v2';
import type {AnalysisRuntime} from '../electron/runtime';
import type {PrdProject,RuntimeConfig,SourceUnit} from '../src/types';

const root=path.resolve('docs/tmp/test-run/vitest/scheduler',randomUUID());
afterAll(()=>rm(root,{recursive:true,force:true}));
const config:RuntimeConfig={adapter:'dsh',provider:'fake',fastModel:'fast',fastReasoningEffort:'low',model:'model',reasoningEffort:'low',maxParallel:1,maxNodeParallel:3};
const project=():PrdProject=>({id:'P',name:'测试',sourceName:'test.md',sourceHash:'H',revision:1,importedAt:'now',rawText:'字段 X 必填。',stage:'inventory',sourceUnits:[],features:[],requirements:[],clarifications:[]});
const input=(prompt:string)=>JSON.parse(prompt.slice(prompt.lastIndexOf('节点输入：')+5));
const terminal=async(scheduler:AnalysisTaskScheduler)=>{for(let index=0;index<300;index++){const task=scheduler.list()[0];if(task&&['completed','needs-attention','failed'].includes(task.status))return task;await new Promise(resolve=>setTimeout(resolve,10))}throw new Error('任务未结束')};

function runtime(prompts:string[]):AnalysisRuntime{return{start:async()=>{},stop:async()=>{},diagnostics:()=>'',promptAndWait:async(_id,prompt)=>{prompts.push(prompt);const value=input(prompt);
  if(prompt.includes('“理解本次补充说明”'))return JSON.stringify({entries:value.sourceUnits.map((unit:SourceUnit)=>({sourceUnitId:unit.id,kind:'business-fact',summary:'作为本次明确业务补充处理'}))});
  if(prompt.includes('“功能候选识别”'))return JSON.stringify({features:[{id:'LOCAL-F1',name:'字段维护',kind:'function',appliesToFeatureIds:[],sourceUnitIds:value.sourceUnits.map((unit:SourceUnit)=>unit.id),state:'draft'}],sourceDispositions:value.sourceUnits.map((unit:SourceUnit)=>({sourceUnitId:unit.id,contentRole:'requirement',reason:'明确要求',featureIds:['LOCAL-F1']}))});
  if(prompt.includes('“功能清单统一”'))return JSON.stringify({features:value.candidates,candidateMappings:value.candidates.map((item:{id:string})=>({candidateId:item.id,featureIds:[item.id]}))});
  if(prompt.includes('“逐功能细化”'))return JSON.stringify({requirements:value.evidenceCatalog.map((evidence:{id:string},index:number)=>({id:`LOCAL-R${index+1}`,title:`需求${index+1}`,behavior:{text:'按原文执行',evidenceIds:[evidence.id]},conditions:[],constraints:[],explicitAcceptanceEvidenceIds:[]})),clarifications:[]});
  if(prompt.includes('“产物依据核查”'))return JSON.stringify({issues:[],relations:value.requirements.length>1?[{id:'LOCAL-REL-1',sourceRequirementId:value.requirements[1].id,targetRequirementId:value.requirements[0].id,kind:'depends-on',evidenceIds:[value.evidenceCatalog[1].id]}]:[]});
  throw new Error(`未处理节点：${prompt.slice(0,80)}`);
}}}

describe('Pipeline 19 调度不变量',()=>{
  it('默认并发为五任务、每任务十节点',()=>{expect(schedulerConcurrency({maxParallel:5,maxNodeParallel:10})).toEqual({taskLimit:5,nodeLimit:10,slotLimit:50})});
  it('提示输入裁剪保留业务字段并移除显示元数据',()=>{expect(compactPromptInput({id:'S1',excerpt:'要求',location:'第1段',label:'标题'})).toMatchObject({id:'S1',excerpt:'要求'})});
  it('首次分析说明按原话拆成用户来源且重复恢复不会重复添加',()=>{const value=project();value.analysisInput={text:'本期只做查询；\n同名按完全一致处理。\n是否需要自动合并？',revision:1,submittedAt:'2026-09-13T10:00:00.000Z',operationId:'OP-1',fingerprint:'abcdef1234567890'};attachInitialUserInput(value);attachInitialUserInput(value);const added=value.sourceUnits.filter(unit=>unit.synthetic);expect(added.map(unit=>unit.excerpt)).toEqual(['本期只做查询；','同名按完全一致处理。','是否需要自动合并？']);expect(added.every(unit=>unit.location.startsWith('用户补充 · 本次分析'))).toBe(true)});
  it('一句话包含相反范围决定时拆成可分别应用的原话单元',()=>{const value=project();value.analysisInput={text:'本期只做活动查询，活动导出本期不做。',revision:1,submittedAt:'2026-09-13T10:00:00.000Z',operationId:'OP-S',fingerprint:'scope-fingerprint'};attachInitialUserInput(value);expect(value.sourceUnits.filter(unit=>unit.synthetic).map(unit=>unit.excerpt)).toEqual(['本期只做活动查询，','活动导出本期不做。'])});
  it('首轮只核查已有产物，不调用全文补漏节点，且运行配置不落密钥',async()=>{const prompts:string[]=[],directory=path.join(root,'initial'),secret={...config,apiKey:'DO-NOT-PERSIST'};const scheduler=new AnalysisTaskScheduler(directory,async()=>secret,()=>{},()=>runtime(prompts));await scheduler.initialize();const created=await scheduler.create(project()),done=await terminal(scheduler);expect(done.status,done.error).toBe('completed');expect(prompts.some(item=>item.includes('原文正向完整性检查')||item.includes('定点补漏')||item.includes('功能候选完整性检查'))).toBe(false);expect(prompts.some(item=>item.includes('“产物依据核查”'))).toBe(true);expect(await readFile(path.join(directory,`${created.id}.json`),'utf8')).not.toContain('DO-NOT-PERSIST')});
  it('细化首轮多个结构错误会一次反馈并在第二轮整体纠正',async()=>{
    const prompts:string[]=[],directory=path.join(root,'detail-correction'),base=runtime(prompts);let detailAttempts=0;
    const correcting:AnalysisRuntime={...base,promptAndWait:async(id,prompt,options)=>{if(prompt.includes('“逐功能细化”')&&++detailAttempts===1){prompts.push(prompt);return JSON.stringify({requirements:[{id:'LOCAL-R1',title:'需求1',behavior:'按原文执行',conditions:['E1'],constraints:[],explicitAcceptanceEvidenceIds:[],sourceUnitIds:['S1'],state:'draft'}],clarifications:[]})}return base.promptAndWait(id,prompt,options)}};
    const scheduler=new AnalysisTaskScheduler(directory,async()=>config,()=>{},()=>correcting);await scheduler.initialize();const created=await scheduler.create(project()),done=await terminal(scheduler);
    expect(done.status,done.error).toBe('completed');expect(detailAttempts).toBe(2);
    const correction=prompts.find(item=>item.includes('请一次修正上述全部问题'))??'';
    expect(correction).toContain('requirements[0].behavior');expect(correction).toContain('requirements[0].conditions[0]');expect(correction).toContain('requirements[0].sourceUnitIds');expect(correction).toContain('{"text":"...","evidenceIds":["E1"]}');
    const persisted=JSON.parse(await readFile(path.join(directory,`${created.id}.json`),'utf8')) as {checkpoint:{validationFailures:Array<{issues?:unknown[]}>}};
    expect(persisted.checkpoint.validationFailures[0].issues?.length).toBeGreaterThanOrEqual(3);
  });
  it('补充说明先形成应用记录且流程不再包含空汇集节点',async()=>{const prompts:string[]=[],directory=path.join(root,'input-application'),value=project();value.analysisInput={text:'同名按完全一致处理。',revision:1,submittedAt:'2026-09-13T10:00:00.000Z',operationId:'OP-I',fingerprint:'input-fingerprint'};const scheduler=new AnalysisTaskScheduler(directory,async()=>config,()=>{},()=>runtime(prompts));await scheduler.initialize();await scheduler.create(value);const done=await terminal(scheduler);expect(done.project.analysisInputApplications,done.error).toMatchObject([{kind:'business-fact',status:'applied',affectedFeatureIds:['F-001']}]);expect(done.steps.map(step=>step.id)).toEqual(['inventory','candidates','unify','details','audit','repair','delivery']);expect(prompts.filter(item=>item.includes('“理解本次补充说明”'))).toHaveLength(1)});
  it('依据核查返回的需求关系进入结果并通过真实关系校验',async()=>{const prompts:string[]=[],directory=path.join(root,'relations'),value=project();value.rawText='创建订单。支付前必须先创建订单。';value.sourceUnits=[{id:'S1',label:'创建',kind:'paragraph',excerpt:'创建订单。',location:'第1段',status:'processed'},{id:'S2',label:'支付',kind:'paragraph',excerpt:'支付前必须先创建订单。',location:'第2段',status:'processed'}];const scheduler=new AnalysisTaskScheduler(directory,async()=>config,()=>{},()=>runtime(prompts));await scheduler.initialize();await scheduler.create(value);const done=await terminal(scheduler);expect(done.project.relations).toMatchObject([{sourceRequirementId:'R-0002',targetRequirementId:'R-0001',kind:'depends-on'}]);expect(done.checkpoint?.checks?.relation.status).toBe('passed')});
  it('取消排队任务后不能发布正式结果',async()=>{const directory=path.join(root,'cancel'),scheduler=new AnalysisTaskScheduler(directory,async()=>config,()=>{},()=>{throw new Error('不应启动')});await scheduler.initialize();const created=await scheduler.create(project());await scheduler.cancel(created.id);const cancelled=scheduler.get(created.id);expect(cancelled?.status).toBe('failed');expect(cancelled?.error).toBe('用户已取消任务')});
  it('重新开始复用冻结输入并保留原失败任务',async()=>{const directory=path.join(root,'restart'),scheduler=new AnalysisTaskScheduler(directory,async()=>config,()=>{},()=>{throw new Error('不应启动')});await scheduler.initialize();const created=await scheduler.create(project());await scheduler.cancel(created.id);const restarted=await scheduler.restart(created.id);expect(restarted.id).not.toBe(created.id);expect(restarted.status).toBe('queued');expect(restarted.project.sourceHash).toBe(created.project.sourceHash);expect(restarted.runtimeConfig?.model).toBe(config.model);expect(scheduler.get(created.id)?.status).toBe('failed');await scheduler.cancel(restarted.id)});
});
