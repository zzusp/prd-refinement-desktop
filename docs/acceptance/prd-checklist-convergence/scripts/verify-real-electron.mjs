import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {_electron as electron} from '@playwright/test';

const [sourceTaskPath,outputRoot,model='gpt-5.6-terra',retryTaskId]=process.argv.slice(2);
assert(sourceTaskPath&&outputRoot,'参数：<原任务JSON> <隔离输出目录> [验收模型]');
const repo=process.cwd(),sourcePath=path.resolve(sourceTaskPath),output=path.resolve(outputRoot);
assert(output.startsWith(path.join(repo,'docs','tmp')+path.sep),'隔离输出必须位于 docs/tmp');
const bytes=await readFile(sourcePath),source=JSON.parse(bytes),sha=value=>createHash('sha256').update(value).digest('hex');
const profile=path.join(output,'profile'),taskRoot=path.join(profile,'analysis-tasks');
await mkdir(taskRoot,{recursive:true});if(!retryTaskId)await writeFile(path.join(taskRoot,`${source.id}.json`),bytes);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
const application=await electron.launch({args:[repo,`--user-data-dir=${profile}`],env});
const summary={sourceTaskId:source.id,sourceTaskSha256:sha(bytes),model,startedAt:new Date().toISOString()};
try{
  const window=await application.firstWindow();await window.waitForLoadState('domcontentloaded');
  const identity=await application.evaluate(({app})=>({pid:process.pid,appPath:app.getAppPath(),userData:app.getPath('userData')}));
  assert.equal(path.resolve(identity.appPath),repo);assert.equal(path.resolve(identity.userData),profile);
  const stored=await window.evaluate(()=>window.prdApp.loadRuntimeConfig());
  const config={...stored,adapter:'codex-oauth',provider:'openai-codex',model,fastModel:model,nodeProfiles:Object.fromEntries(Object.keys(stored.nodeProfiles??{}).map(key=>[key,{model,reasoningEffort:'low'}])),maxParallel:1,maxNodeParallel:10};
  await window.evaluate(value=>window.prdApp.saveRuntimeConfig(value),config);
  const created=retryTaskId
    ? await window.evaluate(async id=>{await window.prdApp.retryAnalysis(id);return (await window.prdApp.loadAnalysisTasks()).find(item=>item.id===id)},retryTaskId)
    : await window.evaluate(id=>window.prdApp.restartAnalysis(id),source.id);
  assert(created);assert.equal(created.checkpoint.pipelineVersion,26);assert.equal(created.project.sourceHash,source.project.sourceHash);
  Object.assign(summary,{identity,taskId:created.id,pipelineVersion:created.checkpoint.pipelineVersion});
  let previous='';
  while(true){
    const task=await window.evaluate(async id=>(await window.prdApp.loadAnalysisTasks()).find(item=>item.id===id),created.id);
    const signature=JSON.stringify([task.status,task.steps.map(step=>step.status)]);
    if(signature!==previous){console.log(JSON.stringify({at:new Date().toISOString(),id:task.id,status:task.status,steps:task.steps.map(step=>[step.id,step.status]),error:task.error}));previous=signature}
    if(['completed','needs-attention','failed'].includes(task.status)){
      const persisted=JSON.parse(await readFile(path.join(taskRoot,`${task.id}.json`),'utf8'));
      assert.equal(persisted.status,task.status);assert.equal(sha(await readFile(sourcePath)),sha(bytes));
      Object.assign(summary,{status:task.status,error:task.error,features:task.project.features.length,requirements:task.project.requirements.length,clarifications:task.project.clarifications.length,delivery:task.project.delivery,artifacts:task.artifacts,completedAt:new Date().toISOString(),sourceUnchanged:true});
      await window.screenshot({path:path.join(output,'terminal.png'),fullPage:true});
      await writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
      if(task.status!=='completed')process.exitCode=1;break;
    }
    await new Promise(resolve=>setTimeout(resolve,3000));
  }
}finally{await application.close()}
