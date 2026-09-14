import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const sourceTaskId='T-14BAB15B';
const run=process.env.PRD_REAL_TASK_RUN==='1';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
const userData=path.join(process.env.APPDATA,'prd-refinement-desktop');
const root=path.join(userData,'analysis-tasks');
const source=JSON.parse(await readFile(path.join(root,`${sourceTaskId}.json`),'utf8'));
if(!['failed','needs-attention'].includes(source.status))throw new Error(`源任务状态不可恢复：${source.status}`);
const stored=JSON.parse(await readFile(path.join(userData,'runtime-config.json'),'utf8'));
if(!run){
  const {encryptedApiKey,...config}=stored;
  process.stdout.write(JSON.stringify({mode:'check',sourceTaskId,status:source.status,pipelineVersion:source.checkpoint?.pipelineVersion,projectId:source.project?.id,sourceHash:source.project?.sourceHash,adapter:config.adapter,model:config.model},null,2));
}else{
  const progressPath=path.join(repository,'docs/tmp/real-task-run-progress.json');
  await writeFile(progressPath,JSON.stringify({state:'starting',sourceTaskId,at:Date.now()},null,2),'utf8');
  if(stored.adapter!=='codex-oauth'||stored.encryptedApiKey)throw new Error('真实恢复脚本仅允许无需解密凭据的 codex-oauth 配置');
  const [{AnalysisTaskScheduler},{createRuntime}]=await Promise.all([
    import(pathToFileURL(path.join(repository,'docs/tmp/desktop-build/current/dist-electron/electron/scheduler-v2.js')).href),
    import(pathToFileURL(path.join(repository,'docs/tmp/desktop-build/current/dist-electron/electron/runtime.js')).href),
  ]);
  const loadConfig=async()=>{
    const {encryptedApiKey,...plain}=stored;
    return plain;
  };
    const scheduler=new AnalysisTaskScheduler(root,loadConfig,()=>{},effective=>createRuntime(effective));
    await scheduler.initialize();
    const created=await scheduler.restart(sourceTaskId);
    await writeFile(progressPath,JSON.stringify({state:'created',sourceTaskId,createdTaskId:created.id,at:Date.now()},null,2),'utf8');
    process.stdout.write(`${JSON.stringify({mode:'run',createdTaskId:created.id,pipelineVersion:created.checkpoint?.pipelineVersion})}\n`);
    const deadline=Date.now()+45*60_000;
    for(;;){
      const current=scheduler.get(created.id);
      if(current&&['completed','needs-attention','failed'].includes(current.status)){
        const summary={taskId:current.id,status:current.status,error:current.error,pipelineVersion:current.checkpoint?.pipelineVersion,progress:current.progress,auditSucceeded:Object.values(current.checkpoint?.auditWorkStates??{}).filter(item=>item.state==='succeeded').length,auditFailed:Object.values(current.checkpoint?.auditWorkStates??{}).filter(item=>item.state==='failed').length,promptMetrics:current.checkpoint?.promptMetrics?.length??0};
        const output=path.join(repository,'docs/acceptance/analysis-execution-work-units/round-1/real-task-run.json');await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(summary,null,2),'utf8');process.stdout.write(JSON.stringify(summary,null,2));
        break;
      }
      if(Date.now()>deadline)throw new Error(`真实任务在时限内未结束：${created.id}`);
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
}
