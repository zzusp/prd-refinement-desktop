import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {_electron as electron} from '@playwright/test';

const [sourceTaskPath,outputRoot,model]=process.argv.slice(2);
assert(sourceTaskPath&&outputRoot&&model,'参数：<原失败任务JSON> <隔离输出目录> <明确指定验收模型>');
const repo=process.cwd(),output=path.resolve(outputRoot),sourcePath=path.resolve(sourceTaskPath);
assert(output.startsWith(path.join(repo,'docs','tmp')+path.sep),'输出必须在 docs/tmp 中');
const bytes=await readFile(sourcePath),source=JSON.parse(bytes),sha=v=>createHash('sha256').update(v).digest('hex');
const buildHashes=Object.fromEntries(await Promise.all(['node-executor','scheduler-v2','model-output-schemas','runtime','domain','audit-repair','refinement-adjustments','source-evidence','main','node-validation'].map(async name=>[name,sha(await readFile(path.join(repo,'docs/tmp/desktop-build/current/dist-electron/electron',`${name}.js`)))])));
assert.equal(source.runtimeConfig.adapter,'codex-oauth');
await mkdir(output,{recursive:true});
// 原任务只复制到隔离 profile；通过产品“重新开始”使用冻结输入，不重新解析现有资料包。
await mkdir(path.join(output,'profile','analysis-tasks'),{recursive:true});
await writeFile(path.join(output,'profile','analysis-tasks',`${source.id}.json`),bytes);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
const application=await electron.launch({args:[repo,`--user-data-dir=${path.join(output,'profile')}`],env});
try{
const window=await application.firstWindow();await window.waitForLoadState('domcontentloaded');
const identity=await application.evaluate(({app})=>({pid:process.pid,appPath:app.getAppPath(),userData:app.getPath('userData')}));
assert.equal(path.resolve(identity.appPath),repo);assert.equal(path.resolve(identity.userData),path.join(output,'profile'));
const config={...source.runtimeConfig,model,fastModel:model,nodeProfiles:Object.fromEntries(Object.keys(source.runtimeConfig.nodeProfiles??{}).map(key=>[key,{model,reasoningEffort:'low'}]))};delete config.credentialRef;delete config.apiKey;
await window.evaluate(config=>window.prdApp.saveRuntimeConfig(config),config);
const created=await window.evaluate(id=>window.prdApp.restartAnalysis(id),source.id);
assert.notEqual(created.id,source.id);assert.equal(created.checkpoint.pipelineVersion,22);assert.equal(created.project.sourceHash,source.project.sourceHash);
await window.getByRole('button',{name:new RegExp(`打开任务 ${created.id}`)}).click();
await window.screenshot({path:path.join(output,'started.png'),fullPage:true});
const summary={identity,buildHashes,sourceTaskId:source.id,taskId:created.id,sourceTaskSha256:sha(bytes),sourceHash:source.project.sourceHash,originalModel:source.runtimeConfig.fastModel,verificationModel:model,startedAt:new Date().toISOString(),status:'running'};
await writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
let previous='';
  while(true){
    const task=await window.evaluate(async id=>(await window.prdApp.loadAnalysisTasks()).find(task=>task.id===id),created.id);
    const signature=JSON.stringify([task.status,task.steps.map(step=>step.status),Object.values(task.checkpoint.nodeReceipts??{}).filter(receipt=>receipt.status==='succeeded').length]);
    if(signature!==previous){console.log(JSON.stringify({at:new Date().toISOString(),taskId:task.id,status:task.status,stages:task.steps.map(step=>({id:step.id,status:step.status})),accepted:Object.values(task.checkpoint.nodeReceipts??{}).filter(receipt=>receipt.status==='succeeded').length,error:task.error}));previous=signature;}
    if(['completed','needs-attention','failed'].includes(task.status)){
      const persisted=JSON.parse(await readFile(path.join(identity.userData,'analysis-tasks',`${task.id}.json`),'utf8'));
      assert.equal(persisted.status,task.status);
      const receipts=Object.values(persisted.checkpoint.nodeReceipts??{});
      Object.assign(summary,{status:task.status,error:task.error,completedAt:new Date().toISOString(),features:task.project.features.length,requirements:task.project.requirements.length,clarifications:task.project.clarifications.length,receiptCount:receipts.length,accepted:receipts.filter(item=>item.status==='succeeded').length,calls:receipts.flatMap(item=>item.attempts).reduce((n,item)=>n+item.calls,0),delivery:task.project.delivery,artifacts:task.artifacts,sourceUnchanged:sha(await readFile(sourcePath))===sha(bytes)});
      assert(summary.sourceUnchanged);await window.screenshot({path:path.join(output,'terminal.png'),fullPage:true});
      await writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
      if(task.status==='failed')process.exitCode=1;
      break;
    }
    await new Promise(resolve=>setTimeout(resolve,3000));
  }
}finally{await application.close();}
