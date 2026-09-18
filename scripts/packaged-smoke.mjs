import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';

const [executablePath,evidenceRoot,proxyUrl]=process.argv.slice(2);
if(!executablePath||!evidenceRoot)throw new Error('用法: node scripts/packaged-smoke.mjs <exe> <证据目录> [代理地址]');
await mkdir(evidenceRoot,{recursive:true});
const app=await electron.launch({executablePath,args:[`--user-data-dir=${path.join(evidenceRoot,'user-data')}`]});
try{
  const window=await app.firstWindow({timeout:30_000});
  await window.waitForLoadState('domcontentloaded');
  await window.waitForFunction(()=>document.querySelector('.app-version')?.textContent!=='v—');
  const result=await window.evaluate(()=>({title:document.title,heading:document.querySelector('h1')?.textContent??'',body:document.body.innerText.slice(0,1000),logoLeft:document.querySelector('.logo')?.getBoundingClientRect().left}));
  if(!result.body.includes('需求分析任务')||!result.body.includes('Runtime 配置'))throw new Error(`打包应用首页内容异常：${JSON.stringify(result)}`);
  if(result.logoLeft!==26)throw new Error(`统一顶部布局左边界异常：${JSON.stringify(result)}`);
  if(proxyUrl){
    await window.getByRole('button',{name:'Runtime 配置'}).click();
    await window.getByLabel('网络代理').fill(proxyUrl);
    await window.getByRole('button',{name:'保存配置'}).click();
    await window.getByText('已保存',{exact:true}).waitFor();
    await window.getByRole('button',{name:'检测 Runtime 连接'}).click();
    await window.locator('.settings-card header em.connected').waitFor({timeout:180_000});
  }
  await window.screenshot({path:path.join(evidenceRoot,'packaged-home.png'),fullPage:true});
  console.log(JSON.stringify({passed:true,proxyReady:Boolean(proxyUrl),...result}));
}finally{await app.close()}
