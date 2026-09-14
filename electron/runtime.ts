import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { RuntimeCallMetric, RuntimeConfig, RuntimeStatus } from '../src/types.js';

export interface RuntimeImage { path:string; mimeType:string }
export type RuntimeOutputSchema = Record<string, unknown>;
export interface ModelOperationRequest {
  operationId:string; instructions:string; input:unknown;
  submission:{name:string;description:string;parameters:RuntimeOutputSchema};
  signal?:AbortSignal; images?:RuntimeImage[]; timeoutMs?:number;
}
export interface ModelOperationResult { value:Record<string,unknown>; completion:'completed'; usage?:RuntimeCallMetric }
export type RuntimeOperationErrorCode='transient'|'protocol'|'authentication'|'capability'|'context'|'cancelled'|'runtime';
export class RuntimeOperationError extends Error {
  constructor(public readonly code:RuntimeOperationErrorCode,message:string,public readonly response?:string){super(message);this.name='RuntimeOperationError'}
}
/** Codex 要求根对象；领域联合保持在 result 内，解码后仍交给原领域契约验收。 */
export function codexOutputContract(parameters:RuntimeOutputSchema){
  const wrapped=parameters.type!=='object';
  return {
    schema:wrapped?{type:'object',properties:{result:parameters},required:['result'],additionalProperties:false}:parameters,
    decode(value:unknown):unknown {
      if(!wrapped)return value;
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'result'))throw new RuntimeOperationError('protocol','Codex 结构化联合提交缺少唯一 result 字段');
      return (value as {result:unknown}).result;
    },
  };
}
function operationErrorCode(error:{code?:string;status?:number;http_status_code?:number;message?:string}):RuntimeOperationErrorCode {
  // CLI 的供应商错误 envelope 可能原样编码在 message 中；只解析协议字段，不猜错误文案。
  if(error.message){try{const envelope=JSON.parse(error.message) as {error?:{code?:string;message?:string};status?:number};if(envelope&&typeof envelope==='object'&&(envelope.error?.code||envelope.status))return operationErrorCode({...envelope.error,status:envelope.status})}catch{/* 非 JSON message 没有分类证明 */}}
  const status=error.status??error.http_status_code;
  if(status===401||status===403)return 'authentication';
  if(status===429||(status!==undefined&&status>=500))return 'transient';
  if(['context_length_exceeded','max_output_tokens','length'].includes(error.code??''))return 'context';
  if(['invalid_api_key','unauthorized'].includes(error.code??''))return 'authentication';
  if(['rate_limit_exceeded','ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','EAI_AGAIN'].includes(error.code??''))return 'transient';
  if(['unsupported_parameter','unsupported_operation','invalid_json_schema'].includes(error.code??''))return 'capability';
  return 'runtime';
}

export interface AnalysisRuntime {
  start(cwd: string, config: RuntimeConfig): Promise<void>;
  executeOperation(request:ModelOperationRequest):Promise<ModelOperationResult>;
  promptAndWait(sessionId: string, text: string, timeoutMs?: number, images?: RuntimeImage[], outputSchema?:RuntimeOutputSchema): Promise<string>;
  stop(): Promise<void>;
  diagnostics(): string;
  metrics?(): RuntimeCallMetric[];
}
export function ensureStructuredCapability(config:RuntimeConfig):void {
  if(config.adapter==='dsh')throw new RuntimeOperationError('capability','当前 DSH SDK 协议不支持结构化模型操作；尚未发起模型调用');
}

export function runtimeEnvironment(config:RuntimeConfig):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={...process.env};
  const value=config.proxyUrl?.trim();
  if(value){
    let proxy:URL;try{proxy=new URL(value)}catch{throw new Error('代理地址格式无效')}
    if(!['http:','https:','socks5:'].includes(proxy.protocol))throw new Error('代理仅支持 http、https 或 socks5 协议');
    if(proxy.username||proxy.password)throw new Error('代理地址不能包含用户名或密码');
    const normalized=proxy.toString();
    env.HTTP_PROXY=normalized;env.HTTPS_PROXY=normalized;env.ALL_PROXY=normalized;
    env.http_proxy=normalized;env.https_proxy=normalized;env.all_proxy=normalized;
  }
  delete env.CODEX_SESSION_ID;delete env.CODEX_THREAD_ID;delete env.CODEX_PERMISSION_PROFILE;
  return env;
}

async function dshLauncher() {
  const root = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh');
  try { const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')) as {version:string};const bin=path.join(root,'lib','bin.js');await access(bin);return {node:process.execPath,bin,version:pkg.version}; } catch { return null; }
}

async function codexLauncher() {
  if(process.platform==='win32'){
    const root=path.join(process.env.LOCALAPPDATA??path.join(os.homedir(),'AppData','Local'),'OpenAI','Codex','bin');
    try { for(const version of (await readdir(root)).sort().reverse()){const bin=path.join(root,version,'codex.exe');try{await access(bin);return {bin,version}}catch{/* 继续 */}} } catch {/* 未安装 */}
    return null;
  }
  const pathCandidates=(process.env.PATH??'').split(path.delimiter).filter(Boolean).map(directory=>path.resolve(directory,'codex'));
  const macCandidates=process.platform==='darwin'?[
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    path.join(os.homedir(),'.local','bin','codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ]:[];
  for(const bin of new Set([...pathCandidates,...macCandidates]))try{await access(bin);return {bin}}catch{/* 继续 */}
  return null;
}

function inspectCli(bin:string,args:string[]):Promise<{ok:boolean;output:string}>{
  return new Promise(resolve=>execFile(bin,args,{windowsHide:true,timeout:10_000,maxBuffer:64*1024},(error,stdout,stderr)=>resolve({ok:!error,output:`${stdout}\n${stderr}`.trim()})));
}
export async function inspectRuntime(config?:RuntimeConfig):Promise<RuntimeStatus>{
  const adapter=config?.adapter??'codex-oauth';
  if(adapter==='codex-oauth'){
    const launcher=await codexLauncher();
    if(!launcher)return {available:false,adapter,reason:'未找到官方 Codex CLI'};
    const [version,auth]=await Promise.all([inspectCli(launcher.bin,['--version']),inspectCli(launcher.bin,['login','status'])]);
    const actualVersion=version.ok?version.output.match(/^codex-cli\s+(\S+)$/m)?.[1]:undefined;
    const authStatus=auth.ok&&/^Logged in using /m.test(auth.output)?'authenticated':!auth.ok&&/^Not logged in\.?$/m.test(auth.output)?'unauthenticated':'error';
    return {available:true,adapter,launcher:launcher.bin,version:actualVersion,authStatus,reason:actualVersion?undefined:'CLI 版本检查失败'};
  }
  const launcher=await dshLauncher();return launcher?{available:true,adapter,version:launcher.version,launcher:launcher.bin}:{available:false,adapter,reason:'未找到 DeepSeek Harness SDK 运行时'};
}
export function createRuntime(config:RuntimeConfig):AnalysisRuntime{return config.adapter==='dsh'?new DshJsonRpcRuntime():new CodexCliRuntime()}
export async function testRuntimeRoute(cwd:string,config:RuntimeConfig):Promise<RuntimeStatus>{const runtime=createRuntime(config);try{await runtime.start(cwd,config);await runtime.promptAndWait(`runtime-probe-${Date.now()}`,'这是连接检测。只回复 OK。',60_000);return {...await inspectRuntime(config),routeReady:true}}catch(error){return {...await inspectRuntime(config),routeReady:false,reason:`${error instanceof Error?error.message:String(error)}${runtime.diagnostics()?`\n${runtime.diagnostics()}`:''}`}}finally{await runtime.stop().catch(()=>undefined)}}

function redactRuntimeError(value:string,knownSecret?:string){
  let result=knownSecret?value.split(knownSecret).join('[已隐藏]'):value;
  result=result.replace(/https?:\/\/[^\s"<>]+/gi,'[网址已隐藏]').replace(/\bBearer\s+[^\s,;]+/gi,'Bearer [已隐藏]').replace(/\b(?:sk-|eyJ)[A-Za-z0-9_.-]+/g,'[已隐藏]').replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[=:]\s*)[^\s,;]+/gi,'$1[已隐藏]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱已隐藏]');
  return result.replace(/[\r\n\t]+/g,' ').slice(0,1000);
}

export class CodexCliRuntime implements AnalysisRuntime {
  private children=new Set<ReturnType<typeof spawn>>();private cancellations=new Map<ReturnType<typeof spawn>,()=>void>();private cwd='';private config?:RuntimeConfig;private stderr='';private calls:RuntimeCallMetric[]=[];
  async start(cwd:string,config:RuntimeConfig){if(!await codexLauncher())throw new Error('未找到官方 Codex CLI');this.cwd=path.resolve(cwd);await mkdir(this.cwd,{recursive:true});this.config=config}
  async executeOperation(request:ModelOperationRequest):Promise<ModelOperationResult>{
    if(request.signal?.aborted)throw new RuntimeOperationError('cancelled','模型操作已取消');
    const objectSchema=(schema:RuntimeOutputSchema):boolean=>schema.type==='object'||(['anyOf','oneOf'].some(key=>Array.isArray(schema[key])&&(schema[key] as RuntimeOutputSchema[]).length>0&&(schema[key] as RuntimeOutputSchema[]).every(objectSchema)));
    if(!request.operationId||!request.submission?.name||!request.submission.parameters||!objectSchema(request.submission.parameters))throw new RuntimeOperationError('capability','模型操作必须提供命名提交方法和对象 Schema');
    const text=`${request.instructions}\n\n提交方法：${request.submission.name}\n${request.submission.description}\n输入参数：\n${JSON.stringify(request.input)}`;
    const wire=codexOutputContract(request.submission.parameters);
    const answer=await this.runPrompt(request.operationId,text,request.timeoutMs,request.images,wire.schema,request.signal,true);
    let value:unknown;try{value=JSON.parse(answer)}catch{throw new RuntimeOperationError('protocol','结构化提交不是完整 JSON',answer)}
    try{value=wire.decode(value)}catch(error){if(error instanceof RuntimeOperationError)throw new RuntimeOperationError(error.code,error.message,answer);throw error}
    if(!value||typeof value!=='object'||Array.isArray(value))throw new RuntimeOperationError('protocol','结构化提交根值必须为对象',answer);
    return {value:value as Record<string,unknown>,completion:'completed',usage:[...this.calls].reverse().find(call=>call.sessionId===request.operationId)};
  }
  async promptAndWait(sessionId:string,text:string,timeoutMs=10*60_000,images:RuntimeImage[]=[],outputSchema?:RuntimeOutputSchema){return this.runPrompt(sessionId,text,timeoutMs,images,outputSchema)}
  private async runPrompt(sessionId:string,text:string,timeoutMs=10*60_000,images:RuntimeImage[]=[],outputSchema?:RuntimeOutputSchema,signal?:AbortSignal,strict=false){
    const launcher=await codexLauncher();if(!launcher||!this.config)throw new RuntimeOperationError('capability','Codex CLI Runtime 尚未启动');
    const startedAt=Date.now(),metric:RuntimeCallMetric={sessionId,adapter:'codex-oauth',model:this.config.model,reasoningEffort:this.config.reasoningEffort,startedAt,completedAt:startedAt,durationMs:0};
    const args=['exec','--json','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--ignore-user-config','--ignore-rules','--disable','apps','--disable','browser_use','--disable','computer_use','--disable','image_generation','--disable','memories','--disable','plugins','--disable','skill_search','--disable','shell_tool','--disable','unified_exec','--disable','workspace_dependencies','--disable','goals','--disable','multi_agent','-C',this.cwd,'-m',this.config.model];if(this.config.reasoningEffort!=='default')args.push('-c',`model_reasoning_effort=${JSON.stringify(this.config.reasoningEffort)}`);if(outputSchema){const schemaPath=path.join(this.cwd,`${sessionId.replace(/[^A-Za-z0-9._-]/g,'_')}.output-schema.json`);await writeFile(schemaPath,JSON.stringify(outputSchema),'utf8');args.push('--output-schema',schemaPath)}for(const image of images)args.push('--image',image.path);args.push('-');
    const child=spawn(launcher.bin,args,{cwd:this.cwd,env:runtimeEnvironment(this.config),stdio:['pipe','pipe','pipe'],windowsHide:true});this.children.add(child);child.stdin!.end(text,'utf8');
    let buffer='',stderrBuffer='',answer='',settled=false,turnFailed=false,turnCompleted=false;const failures:string[]=[];
    const decoder=new StringDecoder('utf8'),stderrDecoder=new StringDecoder('utf8');let terminalError:RuntimeOperationError|undefined;
    return new Promise<string>((resolve,reject)=>{
      const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);this.children.delete(child);this.cancellations.delete(child);metric.completedAt=Date.now();metric.durationMs=metric.completedAt-metric.startedAt;this.calls.push(metric);this.stderr=failures.join('\n');error?reject(error):answer?resolve(answer):reject(new RuntimeOperationError('protocol','Codex 未返回结构化提交'))};
      const abort=()=>{terminalError=new RuntimeOperationError('cancelled','模型操作已取消');child.kill()};
      this.cancellations.set(child,abort);
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      const timer=setTimeout(()=>{terminalError=new RuntimeOperationError('transient',`Codex 阶段执行超时（${timeoutMs}ms）`);child.kill()},timeoutMs);
      let reportedCode:RuntimeOperationErrorCode='runtime';
      const lineEvent=(line:string)=>{try{
        const event=JSON.parse(line) as {type?:string;item?:{type?:string;text?:string};message?:string;error?:{message?:string;code?:string;status?:number;http_status_code?:number};usage?:{input_tokens?:number;cached_input_tokens?:number;output_tokens?:number}};
        if(event.type==='item.completed'&&event.item?.type==='agent_message'&&event.item.text)answer=event.item.text;
        if(event.type==='turn.failed')turnFailed=true;
        if(event.type==='turn.completed')turnCompleted=true;
        if(event.type==='turn.completed'&&event.usage){metric.inputTokens=event.usage.input_tokens;metric.cachedInputTokens=event.usage.cached_input_tokens;metric.outputTokens=event.usage.output_tokens}
        if(event.type==='error'||event.type==='turn.failed'){
          reportedCode=operationErrorCode(event.error??{});
          const raw=event.error?.message??event.message;
          if(typeof raw==='string'){const reason=redactRuntimeError(raw,this.config?.apiKey);if(!failures.includes(reason)){failures.push(reason);if(failures.length>4)failures.shift()}}
        }
      }catch{if(strict&&line.trim())terminalError=new RuntimeOperationError('protocol','Codex 返回损坏的 JSONL 事件')}};
      child.stdout!.on('data',chunk=>{buffer+=decoder.write(chunk);let newline=buffer.indexOf('\n');while(newline>=0){lineEvent(buffer.slice(0,newline));buffer=buffer.slice(newline+1);newline=buffer.indexOf('\n')}});
      child.stderr!.on('data',chunk=>{stderrBuffer=`${stderrBuffer}${stderrDecoder.write(chunk)}`.slice(-8000)});
      child.stdin!.on('error',(error:NodeJS.ErrnoException)=>{terminalError=new RuntimeOperationError(operationErrorCode(error),`Codex 输入传输失败：${redactRuntimeError(error.message,this.config?.apiKey)}`);child.kill()});
      child.once('error',error=>{terminalError=new RuntimeOperationError(operationErrorCode(error as NodeJS.ErrnoException),`Codex 启动失败：${redactRuntimeError(error.message,this.config?.apiKey)}`)});
      child.once('close',code=>{
        buffer+=decoder.end();if(buffer.trim())lineEvent(buffer);
        const succeeded=code===0&&!turnFailed&&(turnCompleted||(!strict&&failures.length===0));
        if(!succeeded&&!failures.length){const safeReason=stderrBuffer.match(/(?:Unknown feature flag: [A-Za-z0-9_-]+|系统找不到指定的路径。? \(os error \d+\))/i)?.[0];if(safeReason)failures.push(safeReason)}
        if(succeeded)failures.length=0;
        const failureCode=strict&&code===0&&!turnFailed&&!turnCompleted?'transient':reportedCode;
        finish(terminalError??(succeeded?undefined:new RuntimeOperationError(failureCode,`Codex 已退出（${code??'unknown'}）${failures.length?`：${failures.join('；')}`:strict&&code===0?'：缺少 turn.completed':''}`)));
      });
    })
  }
  metrics(){return structuredClone(this.calls)}diagnostics(){return this.stderr}async stop(){await Promise.all([...this.children].map(child=>new Promise<void>(resolve=>{child.once('close',()=>resolve());this.cancellations.get(child)?.()})))}
}

export class DshJsonRpcRuntime implements AnalysisRuntime {
  async executeOperation(_request:ModelOperationRequest):Promise<ModelOperationResult>{
    // 当前固定的 dsh-sdk-protocol 0.1.2-rc.1 只有 initialize/session/prompt/shutdown。
    // session/prompt 不接收 Schema，不能以自由文本冒充类型化操作。
    throw new RuntimeOperationError('capability','当前 DSH SDK 协议不支持结构化模型操作；尚未发起模型调用');
  }
  private child?:ReturnType<typeof spawn>;private sequence=0;private pending=new Map<number,{resolve(value:unknown):void;reject(error:Error):void}>();private listeners=new Set<(method:string,params:unknown)=>void>();private stderr='';
  async start(cwd:string,config:RuntimeConfig){const launcher=await dshLauncher();if(!launcher)throw new Error('未找到 DeepSeek Harness SDK 运行时');await mkdir(cwd,{recursive:true});const patchPath=path.join(cwd,'runtime.patch.yml'),credentialPath=path.join(os.homedir(),'.dsh','.credentials.yaml'),sessionRoot=path.join(cwd,'sessions');await writeFile(patchPath,`- id: credentials\n  config:\n    path: ${JSON.stringify(credentialPath.replace(/\\/g,'/'))}\n- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(sessionRoot.replace(/\\/g,'/'))}\n    compression: none\n    packChunks: false\n`,'utf8');const env:NodeJS.ProcessEnv={...runtimeEnvironment(config),DSH_HOME:path.join(os.homedir(),'.dsh'),ELECTRON_RUN_AS_NODE:'1'};if(config.apiKey)env.DEEPSEEK_API_KEY=config.apiKey;const child=spawn(launcher.node,[launcher.bin,'--profile','sdk','--patch',patchPath],{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});this.child=child;child.once('error',error=>{for(const task of this.pending.values())task.reject(error);this.pending.clear()});let buffer='';child.stdout!.on('data',chunk=>{buffer+=chunk.toString('utf8');let newline=buffer.indexOf('\n');while(newline>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);newline=buffer.indexOf('\n');try{const message=JSON.parse(line) as {id?:number;method?:string;params?:unknown;result?:unknown;error?:{message?:string}};if(message.id!==undefined&&this.pending.has(message.id)){const task=this.pending.get(message.id)!;this.pending.delete(message.id);message.error?task.reject(new Error(message.error.message??'Harness 请求失败')):task.resolve(message.result)}else if(message.method)for(const listener of this.listeners)listener(message.method,message.params)}catch{/* 非协议输出 */}}});child.once('exit',code=>{for(const task of this.pending.values())task.reject(new Error(`Harness 已退出（${code??'unknown'}）`));this.pending.clear()});child.stderr!.on('data',chunk=>{this.stderr=`${this.stderr}${chunk.toString('utf8')}`.slice(-4000)});await this.request('initialize',{cwd,provider:config.provider,model:config.model,reasoningEffort:config.reasoningEffort==='default'?undefined:config.reasoningEffort})}
  async promptAndWait(sessionId:string,text:string,timeoutMs=10*60_000,images:RuntimeImage[]=[]){const imageBlocks=await Promise.all(images.map(async image=>{if(!['image/png','image/jpeg','image/webp','image/gif'].includes(image.mimeType))throw new Error('不支持的图片类型');return{type:'image',mimeType:image.mimeType,data:(await readFile(image.path)).toString('base64')}}));const assistant:string[]=[];let running=false,settled=false;return new Promise<string>(async(resolve,reject)=>{const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);unsubscribe();error?reject(error):resolve(assistant.at(-1)??'')};const timer=setTimeout(()=>finish(new Error(`Harness 阶段执行超时（${timeoutMs}ms）`)),timeoutMs);const unsubscribe=this.onNotification((method,raw)=>{const params=raw as {sessionId?:string;status?:string;event?:{type?:string;data?:{message?:{content?:Array<{type?:string;text?:string}>};reason?:{kind?:string;error?:{message?:string}}}}};if(params.sessionId!==sessionId)return;if(method==='session.status'){if(params.status==='running')running=true;else if(params.status==='idle'&&running)finish()}if(method==='session.event'&&params.event?.type==='assistant/message'){const value=params.event.data?.message?.content?.filter(block=>block.type==='text').map(block=>block.text??'').join('');if(value)assistant.push(value)}if(method==='session.event'&&params.event?.type==='turn/end'&&params.event.data?.reason?.kind==='error')finish(new Error(params.event.data.reason.error?.message??'Harness 回合执行失败'))});try{await this.request('session/prompt',{sessionId,contentBlocks:[{type:'text',text},...imageBlocks]})}catch(error){finish(error instanceof Error?error:new Error(String(error)))}})}
  private onNotification(listener:(method:string,params:unknown)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener)}private request(method:string,params?:Record<string,unknown>,timeoutMs=30_000){const input=this.child?.stdin;if(!input?.writable)return Promise.reject(new Error('Harness 尚未启动'));const id=++this.sequence;input.write(`${JSON.stringify({jsonrpc:'2.0',id,method,params})}\n`);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Harness 请求超时：${method}`))},timeoutMs);this.pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}})})}diagnostics(){return this.stderr}async stop(){const child=this.child;if(!child)return;try{await this.request('shutdown',undefined,5_000)}catch{/* 关闭超时后终止进程 */}finally{this.child=undefined;child.kill()}}
}
