import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {_electron as electron} from '@playwright/test';

const [profile,outputRoot]=process.argv.slice(2);
assert(profile&&outputRoot,'参数：<实际用户profile> <验收输出目录>；先正常关闭旧实例');
const repo=process.cwd(),output=path.resolve(outputRoot);
assert(output.startsWith(path.join(repo,'docs','tmp')+path.sep));
const configPath=path.join(profile,'runtime-config.json');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const configHash=hash(await readFile(configPath));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
const application=await electron.launch({args:[repo,`--user-data-dir=${profile}`],env});
try{
  const window=await application.firstWindow();await window.waitForLoadState('domcontentloaded');
  const identity=await application.evaluate(({app})=>({pid:process.pid,appPath:app.getAppPath(),userData:app.getPath('userData')}));
  assert.equal(path.resolve(identity.appPath),repo);assert.equal(path.resolve(identity.userData),path.resolve(profile));
  assert(window.url().startsWith('file:'));
  const tasks=await window.evaluate(async()=>(await window.prdApp.loadAnalysisTasks()).map(({id,status})=>({id,status})));
  assert(tasks.every(task=>!['running','queued'].includes(task.status)));
  await mkdir(output,{recursive:true});await window.screenshot({path:path.join(output,'actual-user-desktop.png'),fullPage:true});
  const summary={identity,url:window.url(),tasks,configUnchanged:hash(await readFile(configPath))===configHash,mainHash:hash(await readFile(path.join(repo,'docs/tmp/desktop-build/current/dist-electron/electron/main.js')))};
  assert(summary.configUnchanged);await writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}finally{await application.close();}
