import { createHash, randomUUID } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { MaterialAddition, MaterialBundle, MaterialFile, MaterialFilePatch, MaterialQuery } from '../src/material-types.js';
import type { PrdProject, SourceUnit } from '../src/types.js';
import { extractDocument } from './document-assets.js';
import { sourceCoverage } from './source-units.js';
import { SourceIndex } from './source-index.js';

const PARSER_VERSION = 'bundle-4-closure';
export const MATERIAL_LIMITS = { files: 1000, fileBytes: 100 * 1024 * 1024, totalBytes: 500 * 1024 * 1024, units: 100000 };
const supported = new Set(['.html','.htm','.doc','.docx','.pdf','.md','.txt','.png','.jpg','.jpeg','.webp','.gif','.svg','.css','.js']);
const documentTypes = new Set(['.html','.htm','.doc','.docx','.pdf','.md','.txt']);
const hash = (data: string|Buffer) => createHash('sha256').update(data).digest('hex');
const safeId = (id: string) => {if(!/^[A-Za-z0-9-]+$/.test(id))throw new Error('资料标识无效');return id};
function logical(input: string) {
  const value=input.replace(/\\/g,'/');
  if(!value||value.startsWith('/')||/[:\x00-\x1f]/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)))throw new Error('资料路径必须是安全的相对路径');
  return value;
}
function contained(root:string,relative:string){const result=path.resolve(root,logical(relative)),rel=path.relative(path.resolve(root),result);if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('资料路径越界');return result}
interface StoredFile extends MaterialFile { blob?: string; originalPath?: string }
interface StoredBundle extends MaterialBundle { files:StoredFile[]; bindings:Record<string,{targetFileId?:string;exclusionReason?:string}> }
interface MaterialIndex { parserVersion:string; revision:number; units:SourceUnit[]; documents:NonNullable<PrdProject['sourceDocuments']>; manifestHash:string }
interface CachedParse { version:string; hash:string; logicalPath:string; result:Awaited<ReturnType<typeof extractDocument>> }
export interface MaterialStoreOptions { readImage?:(unit:SourceUnit,signal:AbortSignal)=>Promise<{readable:boolean;text:string}>; visionKey?:(signal:AbortSignal)=>Promise<string> }

/** 资料包拥有输入和索引；分析运行只取得固定版本副本。 */
export class MaterialBundleStore {
  private queues=new Map<string,Promise<unknown>>();
  private jobs=new Map<string,{controller:AbortController;done:Promise<void>}>();
  private additions=new Map<string,AbortController>();
  private cancellation=new Map<string,number>();
  private indexes=new Map<string,{index:MaterialIndex; reader:SourceIndex}>();
  constructor(private root:string,private options:MaterialStoreOptions={}){}
  private dir(id:string){return path.join(this.root,safeId(id))}
  private manifest(id:string){return path.join(this.dir(id),'bundle.json')}
  private async serial<T>(id:string,action:()=>Promise<T>):Promise<T>{const previous=this.queues.get(id)??Promise.resolve();const current=previous.catch(()=>{}).then(action);this.queues.set(id,current);try{return await current}finally{if(this.queues.get(id)===current)this.queues.delete(id)}}
  private async atomic(file:string,value:unknown){await mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value,null,2),'utf8');for(let attempt=0;;attempt++){try{await rename(temp,file);return}catch(error){const code=(error as NodeJS.ErrnoException).code;if(process.platform!=='win32'||!['EPERM','EBUSY'].includes(code??'')||attempt===4)throw error;await delay(50*(attempt+1))}}}
  private async load(id:string):Promise<StoredBundle>{return JSON.parse(await readFile(this.manifest(id),'utf8')) as StoredBundle}
  private view(b:StoredBundle):MaterialBundle {const {bindings:_,...result}=structuredClone(b);result.files=result.files.map(({blob:_,originalPath:__,...file})=>file);return result}
  private async save(b:StoredBundle){b.updatedAt=new Date().toISOString();await this.atomic(this.manifest(b.id),b)}
  private writable(b:StoredBundle){if(this.jobs.has(b.id)||b.state==='indexing')throw new Error('资料处理中，请先取消再修改')}
  private invalidate(b:StoredBundle){b.revision++;b.state='draft';b.indexedRevision=undefined;b.error=undefined;b.issues=[];b.progress={completed:0,total:b.files.length,phase:'等待识别'};for(const f of b.files)if(f.blob&&!f.exclusionReason){f.status='registered';f.reason=undefined;f.sourceCount=undefined}}
  async initialize(){await mkdir(this.root,{recursive:true});for(const entry of await readdir(this.root,{withFileTypes:true})){if(!entry.isDirectory()||!/^[A-Za-z0-9-]+$/.test(entry.name))continue;let b:StoredBundle;try{b=await this.load(entry.name)}catch{continue}if(b.state==='indexing'){b.state='cancelled';b.error='上次识别被中断，请重新建立索引';await this.save(b)}}}
  async create(){const id='B-'+randomUUID();const b:StoredBundle={id,name:'未命名资料包',revision:1,state:'draft',files:[],references:[],issues:[],bindings:{},progress:{completed:0,total:0,phase:'等待添加资料'},updatedAt:new Date().toISOString()};await this.save(b);return this.view(b)}
  async list(){const result:MaterialBundle[]=[];for(const entry of await readdir(this.root,{withFileTypes:true})){if(entry.isDirectory()&&/^[A-Za-z0-9-]+$/.test(entry.name)){try{result.push(await this.get(entry.name))}catch{/* 损坏清单不伪造正常对象 */}}}return result.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))}
  async get(id:string){return this.view(await this.load(id))}
  async renameBundle(id:string,name:string){return this.serial(id,async()=>{const b=await this.load(id);this.writable(b);const next=name.trim();if(!next)throw new Error('资料包名称不能为空');if(next.length>100)throw new Error('资料包名称不能超过 100 个字符');b.name=next;await this.save(b);return this.view(b)})}
  async deleteBundle(id:string){return this.serial(id,async()=>{const b=await this.load(id);this.writable(b);if(this.additions.has(id))throw new Error('资料处理中，请先取消再删除');await rm(this.dir(id),{recursive:true});for(const key of this.indexes.keys())if(key.startsWith(id+':'))this.indexes.delete(key)})}
  async add(id:string,paths:string[],options:MaterialAddition){const generation=this.cancellation.get(id)??0;return this.serial(id,async()=>{
    const b=await this.load(id);this.writable(b);if(generation!==(this.cancellation.get(id)??0))throw new Error('资料添加已取消');
    if(!['primary','supplement','historical'].includes(options.role)||!['files','directory'].includes(options.kind)||!Array.isArray(paths)||!paths.length)throw new Error('添加资料参数无效');
    if(options.role==='primary'&&(paths.length!==1||options.kind!=='files'))throw new Error('主 PRD 只能选择一个文档');
    const controller=new AbortController();this.additions.set(id,controller);
    const next=structuredClone(b),added:StoredFile[]=[];
    const checkLimits=()=>{const files=[...next.files,...added];if(files.length>MATERIAL_LIMITS.files)throw new Error(`资料超过 ${MATERIAL_LIMITS.files} 个文件，请缩小目录范围`);if(files.reduce((sum,f)=>sum+f.size,0)>MATERIAL_LIMITS.totalBytes)throw new Error('资料总大小超过 500 MiB，请缩小目录范围')};
    const register=async(full:string,relative:string)=>{
      controller.signal.throwIfAborted();
      const file:StoredFile={id:'F-'+randomUUID(),logicalPath:logical(relative),role:options.role,revision:1,size:0,hash:'',status:'registered',originalPath:full};
      try{
        const before=await lstat(full);if(before.isSymbolicLink())throw new Error('不跟随符号链接或目录联接');if(!before.isFile())throw new Error('不是普通文件');
        if(before.size>MATERIAL_LIMITS.fileBytes)throw new Error('单文件超过 100 MiB，请拆分资料');
        file.size=before.size;
        const buffer=await readFile(full);controller.signal.throwIfAborted();const after=await lstat(full);
        if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||buffer.length!==before.size)throw new Error('文件在读取期间发生变化，请重新添加');
        file.hash=hash(buffer);file.blob=file.hash+path.extname(relative).toLowerCase();const target=path.join(this.dir(id),'blobs',file.blob);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,buffer);if(hash(await readFile(target))!==file.hash)throw new Error('文件快照校验失败');
        if(!supported.has(path.extname(relative).toLowerCase())){file.status='blocked';file.reason='此格式暂不支持，请转换或明确排除'}
      }catch(error){if(controller.signal.aborted)throw error;if(error instanceof Error&&error.message.includes('500 MiB'))throw error;file.status='blocked';file.reason=error instanceof Error?error.message:'文件无法读取'}
      const existing=next.files.find(f=>f.logicalPath.toLowerCase()===file.logicalPath.toLowerCase())??added.find(f=>f.logicalPath.toLowerCase()===file.logicalPath.toLowerCase());
      if(existing){if(existing.originalPath===full&&existing.hash===file.hash&&existing.hash){return}if(existing.originalPath===full){Object.assign(existing,{...file,id:existing.id,revision:existing.revision+1});checkLimits();return}throw new Error(`逻辑路径冲突：${relative}。请为新目录设置独立目录名或调整已有文件路径。`)}
      added.push(file);checkLimits();
    };
    const walk=async(full:string,relative:string):Promise<void>=>{
      controller.signal.throwIfAborted();let info;try{info=await lstat(full)}catch{await register(full,relative);return}
      if(info.isSymbolicLink()){await register(full,relative);return}
      if(info.isDirectory()){
        let children;try{children=await readdir(full,{withFileTypes:true})}catch{await register(full,relative);return}
        for(const child of children.sort((a,b)=>a.name.localeCompare(b.name)))await walk(path.join(full,child.name),relative+'/'+child.name);
      }else await register(full,relative);
    };
    try{
      for(const input of paths){if(typeof input!=='string'||!path.isAbsolute(input))throw new Error('请选择本地绝对路径');const info=await lstat(input);if(info.isDirectory()&&!info.isSymbolicLink()){if(options.role==='primary')throw new Error('主 PRD 必须是文档文件');await walk(input,options.mount?logical(options.mount):logical(path.basename(input)))}else{if(options.role==='primary'&&!documentTypes.has(path.extname(input).toLowerCase()))throw new Error('主 PRD 必须是 HTML、DOC、DOCX、PDF、Markdown 或 TXT');await register(input,(options.mount?logical(options.mount)+'/':'')+path.basename(input))}}
      controller.signal.throwIfAborted();if(options.role==='primary'){for(const file of next.files)if(file.role==='primary')file.role='supplement';if(added[0])next.name=path.basename(added[0].logicalPath,path.extname(added[0].logicalPath));else{const primary=next.files.find(f=>f.originalPath===paths[0]);if(primary){primary.role='primary';next.name=path.basename(primary.logicalPath,path.extname(primary.logicalPath))}}}
      next.files.push(...added);this.invalidate(next);await this.save(next);return this.view(next);
    }finally{this.additions.delete(id)}
  })}
  async updateFile(id:string,fileId:string,patch:MaterialFilePatch){return this.serial(id,async()=>{const b=await this.load(id);this.writable(b);const file=b.files.find(f=>f.id===fileId);if(!file)throw new Error('文件不存在');if(patch.logicalPath!==undefined){const next=logical(patch.logicalPath);if(b.files.some(f=>f.id!==fileId&&f.logicalPath.toLowerCase()===next.toLowerCase()))throw new Error('逻辑路径冲突');file.logicalPath=next}if(patch.role){if(!['primary','supplement','historical'].includes(patch.role))throw new Error('资料角色无效');if(patch.role==='primary'){if(!documentTypes.has(path.extname(file.logicalPath).toLowerCase()))throw new Error('主 PRD 必须是文档');for(const f of b.files)if(f.role==='primary')f.role='supplement';b.name=path.basename(file.logicalPath,path.extname(file.logicalPath))}file.role=patch.role}if(patch.exclusionReason!==undefined){if(file.role==='primary'&&patch.exclusionReason.trim())throw new Error('不能排除主 PRD');file.exclusionReason=patch.exclusionReason.trim()||undefined;file.status=file.exclusionReason?'excluded':'registered'}this.invalidate(b);await this.save(b);return this.view(b)})}
  async removeFile(id:string,fileId:string){return this.serial(id,async()=>{const b=await this.load(id);this.writable(b);if(!b.files.some(f=>f.id===fileId))throw new Error('文件不存在');b.files=b.files.filter(f=>f.id!==fileId);this.invalidate(b);await this.save(b);return this.view(b)})}
  async saveAnalysisDraft(id:string,text:string,expectedRevision?:number){return this.serial(id,async()=>{const b=await this.load(id);this.writable(b);const current=b.analysisDraft?.revision??0,value=text.replace(/\r\n/g,'\n');if(value.length>20000)throw new Error('补充说明不能超过 20000 个字符');if(b.analysisDraft?.text===value)return this.view(b);if(expectedRevision!==undefined&&expectedRevision!==current)throw new Error('说明已在其他窗口更新，请刷新后确认最新内容');b.analysisDraft={text:value,revision:current+1,updatedAt:new Date().toISOString()};await this.save(b);return this.view(b)})}
  async index(id:string){const generation=this.cancellation.get(id)??0;return this.serial(id,async()=>{const b=await this.load(id);this.writable(b);if(b.indexedRevision===b.revision)this.invalidate(b);if(b.files.filter(f=>f.role==='primary'&&!f.exclusionReason).length!==1)throw new Error('请指定一个主 PRD');b.state='indexing';b.error=undefined;b.issues=[];b.references=[];b.progress={completed:0,total:b.files.length,phase:'建立文件快照'};await this.save(b);const controller=new AbortController();if(generation!==(this.cancellation.get(id)??0))controller.abort(new Error('索引已取消'));const done=Promise.resolve().then(()=>this.build(b,controller.signal)).finally(()=>{this.jobs.delete(id)});this.jobs.set(id,{controller,done});return this.view(b)})}
  async cancel(id:string){this.cancellation.set(id,(this.cancellation.get(id)??0)+1);this.additions.get(id)?.abort(new Error('用户取消资料添加'));this.jobs.get(id)?.controller.abort(new Error('用户取消索引'));await this.queues.get(id)?.catch(()=>{});const job=this.jobs.get(id);if(job){job.controller.abort(new Error('用户取消索引'));await job.done}return this.get(id)}
  async wait(id:string){await this.jobs.get(id)?.done;return this.get(id)}
  private async build(b:StoredBundle,signal:AbortSignal){
    const revision=b.revision,revisionRoot=path.join(this.dir(b.id),'revisions',String(revision)),inputRoot=path.join(revisionRoot,'input');
    const units:SourceUnit[]=[],documents:MaterialIndex['documents']=[];
    try{
      await mkdir(inputRoot,{recursive:true});
      for(const file of b.files){signal.throwIfAborted();if(file.blob&&!file.exclusionReason){const blob=path.join(this.dir(b.id),'blobs',file.blob);if(hash(await readFile(blob))!==file.hash)throw new Error(`原始快照校验失败：${file.logicalPath}`);const target=contained(inputRoot,file.logicalPath);await mkdir(path.dirname(target),{recursive:true});await copyFile(blob,target)}}
      const visionKey=await this.options.visionKey?.(signal)??'default';
      for(const file of b.files){
        signal.throwIfAborted();b.progress.phase=`读取 ${file.logicalPath}`;
        if(file.exclusionReason){file.status='excluded';b.progress.completed++;continue}
        if(!file.blob||!supported.has(path.extname(file.logicalPath).toLowerCase())){file.status='blocked';b.issues.push({id:'I-'+file.id,fileId:file.id,message:file.reason??'格式无法读取'});b.progress.completed++;continue}
        file.status='reading';await this.save(b);
        try{
          const cachePath=path.join(this.dir(b.id),'cache',file.id+'.json');let cached:CachedParse|undefined;try{cached=JSON.parse(await readFile(cachePath,'utf8'))}catch{/* 首次解析 */}
          let result:CachedParse['result'];
          if(cached?.version===PARSER_VERSION&&cached.hash===file.hash&&cached.logicalPath===file.logicalPath){result=structuredClone(cached.result)}
          else{
            result=await extractDocument(contained(inputRoot,file.logicalPath),path.join(this.dir(b.id),'parsed',file.id,randomUUID()),{signal,followReferences:false});
            signal.throwIfAborted();await this.atomic(cachePath,{version:PARSER_VERSION,hash:file.hash,logicalPath:file.logicalPath,result} satisfies CachedParse);
          }
          if(!result.sourceUnits.length)throw new Error('文档没有可读取内容，请提供有效文档或明确排除');
          if(!sourceCoverage(result.rawText,result.sourceUnits).complete)throw new Error('提取文本与来源账本不一致');
          const prefix=`S-${file.id.slice(2)}-v${file.revision}-${PARSER_VERSION}-`,mapping=new Map(result.sourceUnits.map((unit,i)=>[unit.id,prefix+String(i+1).padStart(4,'0')]));
          for(const unit of result.sourceUnits){unit.id=mapping.get(unit.id)!;unit.fileId=file.id;unit.fileRevision=file.revision;unit.logicalPath=file.logicalPath;unit.sourceRole=file.role;unit.location=`${file.logicalPath} · v${file.revision} · ${unit.location}`;if(unit.context)for(const [old,newId] of mapping)unit.context=unit.context.replaceAll(`[${old}]`,`[${newId}]`);unit.context=`资料角色：${file.role==='primary'?'主 PRD':file.role==='historical'?'历史参考，不覆盖现行要求':'补充参考，不自动覆盖主 PRD'}。冲突不得自动改写主 PRD 要求。\n${unit.context??''}`;
            if(unit.asset&&unit.asset.readStatus==='pending'){
              const asset=unit.asset,visionFile=path.join(this.dir(b.id),'vision',hash(asset.sha256+visionKey)+'.json');let transcription:{readable:boolean;text:string}|undefined;
              if(hash(await readFile(asset.path))!==asset.sha256)throw new Error('图像快照校验失败');
              try{transcription=JSON.parse(await readFile(visionFile,'utf8'))}catch{/* 首次识别 */}
              if(!transcription){if(!this.options.readImage)throw new Error('图像识别运行时未配置');b.progress.phase=`识别图像：${file.logicalPath}`;await this.save(b);transcription=await this.options.readImage(unit,signal);signal.throwIfAborted();if(transcription.readable&&transcription.text.trim())await this.atomic(visionFile,transcription)}
              asset.extractedText=transcription.text;asset.readStatus=transcription.readable&&transcription.text.trim()?'read':'blocked';unit.status=asset.readStatus==='read'?'processed':'blocked';
            }
          }
          units.push(...result.sourceUnits);if(units.length>MATERIAL_LIMITS.units)throw new Error('来源单元超过 100000，请拆分资料包');
          documents.push({fileId:file.id,revision:file.revision,logicalPath:file.logicalPath,role:file.role,rawText:result.rawText});
          const unread=result.sourceUnits.filter(unit=>unit.status==='blocked');file.status=unread.length?'blocked':'read';file.reason=unread.length?`${unread.length} 项内容待处理`:undefined;file.sourceCount=result.sourceUnits.length;
          for(const unit of unread)b.issues.push({id:'I-'+unit.id,fileId:file.id,message:unit.label+(unit.asset?.error?`：${unit.asset.error}`:'')});
        }catch(error){signal.throwIfAborted();file.status='blocked';file.reason=error instanceof Error?error.message:'解析失败';b.issues.push({id:'I-'+file.id,fileId:file.id,message:file.reason})}
        b.progress.completed++;await this.save(b);
      }
      signal.throwIfAborted();b.progress.phase='构建来源索引';await this.save(b);
      b.references=[];
      const index:MaterialIndex={parserVersion:PARSER_VERSION,revision,units,documents,manifestHash:hash(JSON.stringify(b.files.map(f=>[f.id,f.revision,f.hash,f.logicalPath,f.role,f.exclusionReason])))};
      new SourceIndex(units,revision);
      signal.throwIfAborted();await this.atomic(path.join(revisionRoot,'index.json'),index);signal.throwIfAborted();
      b.indexedRevision=revision;b.state=b.issues.length?'needs-materials':'ready';b.progress.phase=b.issues.length?'等待补充资料':'索引就绪';await this.atomic(path.join(revisionRoot,'manifest.json'),b);signal.throwIfAborted();await this.save(b);signal.throwIfAborted();
    }catch(error){b.state=signal.aborted?'cancelled':'failed';b.error=error instanceof Error?error.message:'索引失败';b.progress.phase=signal.aborted?'已取消':'索引失败';await this.save(b)}
  }
  private async indexed(id:string){
    const b=await this.load(id);if(b.indexedRevision!==b.revision||!['ready','needs-materials'].includes(b.state))throw new Error('请先完成当前版本资料索引');
    const key=id+':'+b.revision;let cached=this.indexes.get(key);
    if(!cached){const index=JSON.parse(await readFile(path.join(this.dir(id),'revisions',String(b.revision),'index.json'),'utf8')) as MaterialIndex;if(index.parserVersion!==PARSER_VERSION)throw new Error('资料解析规则已升级，请重新建立索引');cached={index,reader:new SourceIndex(index.units,index.revision)};this.indexes.set(key,cached);if(this.indexes.size>3)this.indexes.delete(this.indexes.keys().next().value!)}
    return {b,...cached};
  }
  async query(id:string,query:MaterialQuery){const {reader}=await this.indexed(id);return reader.query(query)}
  async read(id:string,ids:string[]){const {reader}=await this.indexed(id);if(ids.length>100)throw new Error('单次最多读取 100 个来源单元');return reader.read(ids)}
  async project(id:string,snapshotRoot?:string):Promise<PrdProject>{
    const {b,index}=await this.indexed(id);if(b.state!=='ready')throw new Error('资料未就绪，请先补齐或处置缺口');
    const primary=b.files.find(f=>f.role==='primary')!,sourceUnits=structuredClone(index.units);
    if(snapshotRoot){
      if(!path.isAbsolute(snapshotRoot))throw new Error('任务快照目录必须是绝对路径');
      const revisionRoot=path.join(this.dir(b.id),'revisions',String(b.revision));
      try{
        await mkdir(path.dirname(snapshotRoot),{recursive:true});
        await mkdir(snapshotRoot,{recursive:false});
        await cp(path.join(revisionRoot,'input'),path.join(snapshotRoot,'input'),{recursive:true,errorOnExist:true,force:false});
        for(const unit of sourceUnits){
          if(!unit.asset)continue;
          if(hash(await readFile(unit.asset.path))!==unit.asset.sha256)throw new Error(`图片资产哈希不匹配：${unit.id}`);
          const extension=path.extname(unit.asset.path).toLowerCase(),target=path.join(snapshotRoot,'assets',`${unit.asset.sha256}${extension}`);
          await mkdir(path.dirname(target),{recursive:true});
          try{await copyFile(unit.asset.path,target,1)}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
          if(hash(await readFile(target))!==unit.asset.sha256)throw new Error(`任务图片快照校验失败：${unit.id}`);
          unit.asset.path=target;
        }
      }catch(error){await rm(snapshotRoot,{recursive:true,force:true});throw error}
    }
    return {id:'P-'+randomUUID(),name:b.name,sourceName:primary.logicalPath,sourceHash:index.manifestHash,revision:b.revision,importedAt:new Date().toISOString(),rawText:index.documents.map(d=>d.rawText).join('\n\n'),stage:'inventory',sourceUnits,sourceDocuments:structuredClone(index.documents),materialBundle:{id:b.id,revision:b.revision},inputSnapshotPath:snapshotRoot,rules:[],features:[],requirements:[],clarifications:[]}
  }
  async shutdown(){for(const job of this.jobs.values())job.controller.abort(new Error('应用关闭，索引已取消'));await Promise.all(Array.from(this.jobs.values()).map(j=>j.done))}
}
