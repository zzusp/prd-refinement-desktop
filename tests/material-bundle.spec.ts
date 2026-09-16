import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { MaterialBundleStore } from '../electron/material-bundle';
import type { PrdProject } from '../src/types';
import { createTestWorkspace } from './test-workspace';
vi.mock('node:fs/promises',async()=>{const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');return {...actual,rename:vi.fn(actual.rename)}});
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})});
async function setup(){const root=await createTestWorkspace('prd-material');roots.push(root);const store=new MaterialBundleStore(path.join(root,'store'),{readImage:async()=>({readable:true,text:'图标：筛选按钮'})});await store.initialize();return {root,store,bundle:await store.create()}}
async function file(root:string,name:string,text:string){const p=path.join(root,name);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,text);return p}
const addPrimary=async(store:MaterialBundleStore,id:string,p:string)=>store.add(id,[p],{kind:'files',role:'primary'});
const index=async(store:MaterialBundleStore,id:string)=>{await store.index(id);return store.wait(id)};
describe('资料包快照、索引和恢复',()=>{
 it('主文档和补充文件按身份与位置检索，原文件变动不影响固定快照',async()=>{
  const {root,store,bundle}=await setup();const main=await file(root,'main.md','# 订单\n\n订单编号必填');await addPrimary(store,bundle.id,main);await store.add(bundle.id,[await file(root,'more.txt','退款金额不能超过订单金额')],{kind:'files',role:'supplement'});
  expect((await index(store,bundle.id)).state).toBe('ready');const p=await store.project(bundle.id);expect(p.sourceDocuments).toHaveLength(2);expect(p.materialSnapshot).toMatchObject({revision:3,state:'ready',files:[{logicalPath:'main.md',role:'primary',status:'read'},{logicalPath:'more.txt',role:'supplement',status:'read'}]});expect(new Set(p.sourceUnits.map(u=>u.id)).size).toBe(p.sourceUnits.length);expect(p.sourceUnits.every(u=>u.location.includes(u.logicalPath!))).toBe(true);
  await writeFile(main,'改写源文件');expect((await store.project(bundle.id)).rawText).toContain('订单编号必填');const q=await store.query(bundle.id,{query:'退款'});expect(q.total).toBe(1);expect(q.items[0].sourceRole).toBe('supplement');await expect(store.read(bundle.id,['S-not-owned'])).rejects.toThrow();
 });
 it('任务输入快照在资料包删除后仍保留文件和图片引用',async()=>{
  const {root,store,bundle}=await setup();const image=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>').toString('base64');
  await addPrimary(store,bundle.id,await file(root,'main.html',`<p>筛选规则</p><img src="data:image/svg+xml;base64,${image}">`));expect((await index(store,bundle.id)).state).toBe('ready');
  const snapshot=path.join(root,'tasks','input-snapshot'),project=await store.project(bundle.id,snapshot),asset=project.sourceUnits.find(unit=>unit.asset)?.asset;
  expect(asset?.path.startsWith(snapshot)).toBe(true);expect(await readFile(path.join(snapshot,'input','main.html'),'utf8')).toContain('筛选规则');expect(asset&&await readFile(asset.path)).toBeTruthy();
  await store.deleteBundle(bundle.id);await access(path.join(snapshot,'input','main.html'));await access(asset!.path);expect(project.sourceUnits.find(unit=>unit.asset)?.asset?.path).toBe(asset!.path);
 });
 it('从任务冻结快照创建可编辑调整资料且不依赖原资料包',async()=>{
  const {root,store,bundle}=await setup();await addPrimary(store,bundle.id,await file(root,'main.md','# 订单\n\n支持提交订单'));await store.add(bundle.id,[await file(root,'docs/rule.txt','订单金额必须大于零')],{kind:'files',role:'supplement',mount:'规则'});await store.saveAnalysisDraft(bundle.id,'按业务阶段拆分',0);await index(store,bundle.id);
  const snapshot=path.join(root,'tasks','input-snapshot'),project=await store.project(bundle.id,snapshot);project.analysisInput={text:'按业务阶段拆分',revision:1,submittedAt:'now',operationId:'OP-BASE',fingerprint:'input'};await store.deleteBundle(bundle.id);
  const prepared=await store.prepareAdjustment('T-BASE',2,project),again=await store.prepareAdjustment('T-BASE',2,project);
  expect(again.id).toBe(prepared.id);expect(prepared.adjustmentBase).toEqual({taskId:'T-BASE',resultVersion:2});expect(prepared.analysisDraft?.text).toBe('按业务阶段拆分');expect(prepared.files.map(item=>[item.logicalPath,item.role])).toEqual([['main.md','primary'],['规则/rule.txt','supplement']]);expect((await readFile(path.join(root,'store',prepared.id,'blobs',prepared.files[0].hash+'.md'),'utf8'))).toContain('支持提交订单');
 });
 it('旧任务没有冻结资料时仍可创建空草稿并重新选择主 PRD',async()=>{
  const {store}=await setup(),project={id:'P',name:'旧任务',sourceName:'old.md',sourceHash:'x',revision:1,importedAt:'now',rawText:'旧内容',stage:'review',sourceUnits:[],features:[],requirements:[],clarifications:[]} as PrdProject;
  const prepared=await store.prepareAdjustment('T-OLD',1,project);expect(prepared.files).toEqual([]);expect(prepared.adjustmentBase).toEqual({taskId:'T-OLD',resultVersion:1});
 });
 it('旧任务缺少资料快照元数据时从冻结输入和来源文档恢复已有空草稿',async()=>{
  const {root,store}=await setup(),snapshot=path.join(root,'legacy-snapshot');
  await mkdir(path.join(snapshot,'input','参考'),{recursive:true});
  await writeFile(path.join(snapshot,'input','main.md'),'主需求','utf8');
  await writeFile(path.join(snapshot,'input','参考','rule.txt'),'补充规则','utf8');
  const project={id:'P',name:'旧任务',sourceName:'main.md',sourceHash:'x',revision:1,importedAt:'now',rawText:'主需求',stage:'review',sourceUnits:[],sourceDocuments:[
   {fileId:'F-MAIN',revision:1,logicalPath:'main.md',role:'primary' as const,rawText:'主需求'},
   {fileId:'F-RULE',revision:1,logicalPath:'参考/rule.txt',role:'supplement' as const,rawText:'补充规则'}
  ],inputSnapshotPath:snapshot,analysisInput:{text:'沿用当前说明',revision:1,submittedAt:'now',operationId:'OP-LEGACY',fingerprint:'legacy'},features:[],requirements:[],clarifications:[]} as PrdProject;
  const empty=await store.prepareAdjustment('T-LEGACY',2,{...project,inputSnapshotPath:undefined});expect(empty.files).toEqual([]);
  const restored=await store.prepareAdjustment('T-LEGACY',2,project);
  expect(restored.id).toBe(empty.id);expect(restored.files.map(file=>[file.logicalPath,file.role])).toEqual([['main.md','primary'],['参考/rule.txt','supplement']]);expect(restored.analysisDraft?.text).toBe('沿用当前说明');
 });
 it('只处理用户上传的文件，不根据文档引用判断缺件',async()=>{
  const {root,store,bundle}=await setup();await addPrimary(store,bundle.id,await file(root,'main.html','<h1>订单</h1><p>点击筛选</p><img src="assets/filter.svg">'));
  const ready=await index(store,bundle.id);expect(ready.state,JSON.stringify(ready.issues)).toBe('ready');expect(ready.references).toEqual([]);expect(ready.issues).toEqual([]);expect((await store.project(bundle.id)).rawText).toContain('点击筛选');
 });
 it('不会读取主文档旁边但未上传的文件',async()=>{
  const {root,store,bundle}=await setup();await file(root,'secret.png','not-an-image');await addPrimary(store,bundle.id,await file(root,'main.html','<p>规则</p><img src="secret.png"><iframe src="prototype.html"></iframe>'));const ready=await index(store,bundle.id);expect(ready.state).toBe('ready');expect(ready.references).toEqual([]);expect(ready.issues).toEqual([]);expect((await store.project(bundle.id)).sourceUnits.some(unit=>unit.asset)).toBe(false);
 });
 it('同名异目录不合并，同逻辑路径冲突拒绝且不部分提交',async()=>{
  const {root,store,bundle}=await setup();await addPrimary(store,bundle.id,await file(root,'a/main.txt','A'));const second=await file(root,'b/main.txt','B');await expect(store.add(bundle.id,[second],{kind:'files',role:'supplement'})).rejects.toThrow('冲突');expect((await store.get(bundle.id)).files).toHaveLength(1);await store.add(bundle.id,[second],{kind:'files',role:'supplement',mount:'b'});expect((await index(store,bundle.id)).state).toBe('ready');expect((await store.project(bundle.id)).sourceDocuments).toHaveLength(2);
 });
 it('符号链接不跟随、未知格式必须明确处置，不丢登记记录',async()=>{
  const {root,store,bundle}=await setup();await addPrimary(store,bundle.id,await file(root,'main.txt','主文档'));await file(root,'extra/unknown.bin','binary');await mkdir(path.join(root,'outside'));await symlink(path.join(root,'outside'),path.join(root,'extra/link'),'junction');const added=await store.add(bundle.id,[path.join(root,'extra')],{kind:'directory',role:'supplement'});expect(added.files).toHaveLength(3);const b=await index(store,bundle.id);expect(b.state).toBe('needs-materials');expect(b.files.find(f=>f.logicalPath.endsWith('/link'))?.reason).toContain('链接');
 });
 it('资料路径穿越拒绝，删除/角色修改使旧索引失效而旧快照保留',async()=>{
  const {root,store,bundle}=await setup();const b=await addPrimary(store,bundle.id,await file(root,'main.txt','要求'));await expect(store.updateFile(bundle.id,b.files[0].id,{logicalPath:'../escape'})).rejects.toThrow();const ready=await index(store,bundle.id);const old=await store.project(bundle.id);await store.add(bundle.id,[await file(root,'extra.txt','补充')],{kind:'files',role:'supplement'});await expect(store.project(bundle.id)).rejects.toThrow('索引');const prior=JSON.parse(await readFile(path.join(root,'store',bundle.id,'revisions',String(ready.revision),'index.json'),'utf8'));expect(prior.units[0].excerpt).toBe(old.sourceUnits[0].excerpt);
 });
 it('取消视觉识别不产生ready，重启保留cancelled和文件清单',async()=>{
  const {root,bundle}=await setup();let entered=false;const store=new MaterialBundleStore(path.join(root,'store'),{readImage:async(_u,signal)=>{entered=true;return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true}))}});await store.initialize();await addPrimary(store,bundle.id,await file(root,'main.html','<p>规则</p><img src="data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>').toString('base64')+'">'));await store.index(bundle.id);for(let n=0;n<100&&!entered;n++)await new Promise(r=>setTimeout(r,10));expect(entered).toBe(true);expect((await store.cancel(bundle.id)).state).toBe('cancelled');const reopened=new MaterialBundleStore(path.join(root,'store'));await reopened.initialize();expect((await reopened.get(bundle.id)).state).toBe('cancelled');await expect(reopened.project(bundle.id)).rejects.toThrow();
 });
 it('应用重启将持久化indexing改为取消，不能把半成品当可用',async()=>{
  const {root,store,bundle}=await setup();const manifest=path.join(root,'store',bundle.id,'bundle.json');const raw=JSON.parse(await readFile(manifest,'utf8'));raw.state='indexing';await writeFile(manifest,JSON.stringify(raw));const reopened=new MaterialBundleStore(path.join(root,'store'));await reopened.initialize();expect((await reopened.get(bundle.id)).state).toBe('cancelled');
 });
 it('空主文档阻断，不以零来源判为就绪',async()=>{
  const {root,store,bundle}=await setup();await addPrimary(store,bundle.id,await file(root,'empty.txt','  '));const b=await index(store,bundle.id);expect(b.state).toBe('needs-materials');expect(b.files[0].reason).toContain('没有可读取内容');await expect(store.project(bundle.id)).rejects.toThrow();
 });
 it('重复索引产生新版本，已提交索引不覆盖',async()=>{
  const {root,store,bundle}=await setup();await addPrimary(store,bundle.id,await file(root,'main.txt','规则'));const first=await index(store,bundle.id);const target=path.join(root,'store',bundle.id,'revisions',String(first.revision),'index.json');const before=await readFile(target,'utf8');const second=await index(store,bundle.id);expect(second.revision).toBeGreaterThan(first.revision);expect(await readFile(target,'utf8')).toBe(before);
 });
 it('索引启动同刻取消，不能漏过尚未注册的工作',async()=>{
  const {root,store,bundle}=await setup();await addPrimary(store,bundle.id,await file(root,'main.txt','规则'));const start=store.index(bundle.id);const cancelled=store.cancel(bundle.id);await start;expect((await cancelled).state).toBe('cancelled');await expect(store.project(bundle.id)).rejects.toThrow();
 });
 it('同一文件重复添加不增加清单数量或改变来源身份',async()=>{
  const {root,store,bundle}=await setup();const p=await file(root,'main.txt','规则');const first=await addPrimary(store,bundle.id,p);const second=await addPrimary(store,bundle.id,p);expect(second.files).toHaveLength(1);expect(second.files[0].id).toBe(first.files[0].id);expect(second.files[0].revision).toBe(first.files[0].revision);
 });
 it('资料包可重命名并整体删除，名称变更不使索引失效',async()=>{
  const {root,store,bundle}=await setup();await addPrimary(store,bundle.id,await file(root,'main.txt','规则'));const ready=await index(store,bundle.id);const renamed=await store.renameBundle(bundle.id,'  订单需求资料  ');expect(renamed.name).toBe('订单需求资料');expect(renamed.revision).toBe(ready.revision);expect(renamed.indexedRevision).toBe(ready.indexedRevision);expect((await store.project(bundle.id)).name).toBe('订单需求资料');await expect(store.renameBundle(bundle.id,'   ')).rejects.toThrow('不能为空');await expect(store.renameBundle(bundle.id,'文'.repeat(101))).rejects.toThrow('100');await store.deleteBundle(bundle.id);expect(await store.list()).toEqual([]);await expect(store.get(bundle.id)).rejects.toThrow();await expect(readFile(path.join(root,'store',bundle.id,'bundle.json'),'utf8')).rejects.toThrow();
 });
 it('分析说明独立持久化且不使文件索引失效',async()=>{
  const {root,store,bundle}=await setup();await addPrimary(store,bundle.id,await file(root,'main.txt','订单规则'));const ready=await index(store,bundle.id);
  const saved=await store.saveAnalysisDraft(bundle.id,'本期只做查询；同名按完全一致处理。',0);
  expect(saved.analysisDraft).toMatchObject({text:'本期只做查询；同名按完全一致处理。',revision:1});expect(saved.revision).toBe(ready.revision);expect(saved.indexedRevision).toBe(ready.indexedRevision);
  expect((await store.saveAnalysisDraft(bundle.id,saved.analysisDraft!.text,0)).analysisDraft?.revision).toBe(1);
  await expect(store.saveAnalysisDraft(bundle.id,'另一份说明',0)).rejects.toThrow('其他窗口');
 });
 it('资料包正在索引时拒绝删除',async()=>{
  const {root,bundle}=await setup();let entered=false;const store=new MaterialBundleStore(path.join(root,'store'),{readImage:async(_unit,signal)=>{entered=true;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true}))}});await store.initialize();const image=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>').toString('base64');await addPrimary(store,bundle.id,await file(root,'main.html',`<p>规则</p><img src="data:image/svg+xml;base64,${image}">`));await store.index(bundle.id);for(let n=0;n<100&&!entered;n++)await new Promise(resolve=>setTimeout(resolve,10));expect(entered).toBe(true);await expect(store.deleteBundle(bundle.id)).rejects.toThrow('先取消再修改');expect((await store.cancel(bundle.id)).state).toBe('cancelled');
 });

 it('Windows短暂改名占用有界重试，持久失败保留原清单',async()=>{
  if(process.platform!=='win32')return;
  const {root,store,bundle}=await setup();const p=await file(root,'main.txt','规则');const original=(await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;const spy=vi.mocked(fs.rename);spy.mockImplementation(original);spy.mockRejectedValueOnce(Object.assign(new Error('busy'),{code:'EPERM'}));expect((await addPrimary(store,bundle.id,p)).files).toHaveLength(1);
  const before=await store.get(bundle.id);spy.mockRejectedValue(Object.assign(new Error('locked'),{code:'EPERM'}));await expect(store.updateFile(bundle.id,before.files[0].id,{logicalPath:'renamed.txt'})).rejects.toThrow('locked');expect((await store.get(bundle.id)).files[0].logicalPath).toBe('main.txt');
 });
 it('HTML与独立CSS、JS和背景图均完成登记读取，不把代码当业务段落',async()=>{
  const {root,store,bundle}=await setup();await addPrimary(store,bundle.id,await file(root,'main.html','<p>订单备注</p><link rel="stylesheet" href="assets/style.css"><script src="assets/app.js"></script>'));await file(root,'assets/style.css','body{background:url(icon.svg)}');await file(root,'assets/app.js','const label="订单备注";');await file(root,'assets/icon.svg','<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12"/></svg>');await store.add(bundle.id,[path.join(root,'assets')],{kind:'directory',role:'supplement'});const b=await index(store,bundle.id);expect(b.state,JSON.stringify(b.issues)).toBe('ready');expect(b.files).toHaveLength(4);const p=await store.project(bundle.id);expect(p.sourceUnits.filter(u=>u.logicalPath?.endsWith('.js')).every(u=>u.kind==='attachment')).toBe(true);
 });

});
