import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
const mocks=vi.hoisted(()=>({spawn:vi.fn(),execFile:vi.fn(),access:vi.fn(),readdir:vi.fn(),writeFile:vi.fn()}));
vi.mock('node:child_process',()=>({spawn:mocks.spawn,execFile:mocks.execFile}));
vi.mock('node:fs/promises',()=>({access:mocks.access,mkdir:vi.fn(async()=>{}),readFile:vi.fn(),readdir:mocks.readdir,writeFile:mocks.writeFile}));
import { CodexCliRuntime, DshJsonRpcRuntime, inspectRuntime, runtimeEnvironment } from '../electron/runtime';
import type { RuntimeConfig } from '../src/types';
const config:RuntimeConfig={adapter:'codex-oauth',provider:'',model:'fake',reasoningEffort:'low',maxParallel:1,apiKey:'CONFIG-SECRET'};
function child(){return Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()})}
beforeEach(()=>{mocks.spawn.mockReset();mocks.access.mockReset().mockResolvedValue(undefined);mocks.readdir.mockReset().mockResolvedValue(['1.0']);mocks.writeFile.mockReset().mockResolvedValue(undefined)});
async function started(){const runtime=new CodexCliRuntime();await runtime.start('test-runtime',config);return runtime}
async function flushSpawn(){for(let i=0;i<10;i++)await Promise.resolve()}
const operation={operationId:'detail-batch',instructions:'提交结果',input:{source:'中文'},submission:{name:'submit_details',description:'提交',parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}};
describe('类型化 Runtime 操作',()=>{
  it('生产主入口和调度器不再绕过类型化操作调用普通文本',async()=>{
    const fs=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    for(const entry of ['electron/main.ts','electron/scheduler-v2.ts']){
      const source=await fs.readFile(path.resolve(entry),'utf8');expect(source).not.toContain('.promptAndWait(');expect(source).toContain('executeNode(');
    }
  });
  it('必需 Schema 且 UTF8 中文跨块不损坏，仅完整结束后交付',async()=>{
    const process=child();mocks.spawn.mockReturnValue(process);const runtime=await started();const pending=runtime.executeOperation(operation);await flushSpawn();
    const bytes=Buffer.from(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text:'中文'})}})+'\n');
    for(const byte of bytes)process.stdout.write(Buffer.from([byte]));
    process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:2}}));process.emit('close',0);
    expect(await pending).toMatchObject({value:{text:'中文'},completion:'completed',usage:{inputTokens:3}});
    expect(mocks.spawn.mock.calls[0][1]).toContain('--output-schema');
  });
  it.each([['{"text":"ok"}',false,'transient'],['broken',true,'protocol'],['[]',true,'protocol']])('拒绝不完整或损坏提交 %s',async(answer,completed,code)=>{
    const process=child();mocks.spawn.mockReturnValue(process);const runtime=await started();const pending=runtime.executeOperation(operation);const rejected=expect(pending).rejects.toMatchObject({code});await flushSpawn();
    process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:answer}})+'\n');if(completed)process.stdout.write('{"type":"turn.completed"}\n');process.emit('close',0);await rejected;
  });
  it.each([[401,'authentication'],[429,'transient'],[503,'transient']])('原生状态 %s 分类为 %s',async(status,code)=>{
    const process=child();mocks.spawn.mockReturnValue(process);const runtime=await started();const pending=runtime.executeOperation(operation);const rejected=expect(pending).rejects.toMatchObject({code});await flushSpawn();process.stdout.write(JSON.stringify({type:'turn.failed',error:{status,message:'失败'}})+'\n');process.emit('close',1);await rejected;
  });
  it('取消等待进程 close，拒绝迟到成功',async()=>{
    const process=child();mocks.spawn.mockReturnValue(process);const runtime=await started(),controller=new AbortController();let settled=false;
    const pending=runtime.executeOperation({...operation,signal:controller.signal}).finally(()=>{settled=true});const rejected=expect(pending).rejects.toMatchObject({code:'cancelled'});await flushSpawn();controller.abort();await flushSpawn();expect(process.kill).toHaveBeenCalledOnce();expect(settled).toBe(false);
    process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}\n{"type":"turn.completed"}\n');process.emit('close',0);await rejected;
  });
  it('超时等待进程 close 后才允许重试',async()=>{
    vi.useFakeTimers();try{const process=child();mocks.spawn.mockReturnValue(process);const runtime=await started();let settled=false;const pending=runtime.executeOperation({...operation,timeoutMs:10}).finally(()=>{settled=true});const rejected=expect(pending).rejects.toMatchObject({code:'transient'});await flushSpawn();await vi.advanceTimersByTimeAsync(11);expect(settled).toBe(false);expect(process.kill).toHaveBeenCalledOnce();process.emit('close',null);await rejected}finally{vi.useRealTimers()}
  });
  it('DSH 不支持结构化协议时零调用明确失败',async()=>{await expect(new DshJsonRpcRuntime().executeOperation(operation)).rejects.toMatchObject({code:'capability'});expect(mocks.spawn).not.toHaveBeenCalled()});
  it('缺失提交 Schema 在进程启动前拒绝',async()=>{const runtime=await started();await expect(runtime.executeOperation({...operation,submission:{...operation.submission,parameters:{}}})).rejects.toMatchObject({code:'capability'});expect(mocks.spawn).not.toHaveBeenCalled()});
  it('根联合在 Codex wire 中包裹并解码，不改变候选领域对象',async()=>{
    const process=child();mocks.spawn.mockReturnValue(process);const runtime=await started();const union={anyOf:[{type:'object',properties:{a:{type:'string'}},required:['a'],additionalProperties:false},{type:'object',properties:{b:{type:'string'}},required:['b'],additionalProperties:false}]};const pending=runtime.executeOperation({...operation,submission:{...operation.submission,parameters:union}});await flushSpawn();
    expect(JSON.parse(mocks.writeFile.mock.calls.at(-1)![1])).toEqual({type:'object',properties:{result:union},required:['result'],additionalProperties:false});
    process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"{\\"result\\":{\\"a\\":\\"中文\\"}}"}}\n{"type":"turn.completed"}\n');process.emit('close',0);expect(await pending).toMatchObject({value:{a:'中文'},completion:'completed'});
  });
  it('原生上下文错误不猜文案分类',async()=>{
    const process=child();mocks.spawn.mockReturnValue(process);const runtime=await started();const pending=runtime.executeOperation(operation);const rejected=expect(pending).rejects.toMatchObject({code:'context'});await flushSpawn();process.stdout.write('{"type":"turn.failed","error":{"code":"context_length_exceeded","message":"失败"}}\n');process.emit('close',1);await rejected;
  });
  it('CLI 包装的 JSON 供应商错误仍按 code 分类',async()=>{
    const process=child();mocks.spawn.mockReturnValue(process);const runtime=await started();const pending=runtime.executeOperation(operation);const rejected=expect(pending).rejects.toMatchObject({code:'capability'});await flushSpawn();process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:JSON.stringify({error:{code:'invalid_json_schema',message:'schema无效'},status:400})}})+'\n');process.emit('close',1);await rejected;
  });
  it('stop 等待 close 并禁止迟到成功',async()=>{
    const process=child();mocks.spawn.mockReturnValue(process);const runtime=await started();const pending=runtime.executeOperation(operation);const rejected=expect(pending).rejects.toMatchObject({code:'cancelled'});await flushSpawn();let stopped=false;const stopping=runtime.stop().then(()=>{stopped=true});await flushSpawn();expect(stopped).toBe(false);process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}\n{"type":"turn.completed"}\n');process.emit('close',0);await rejected;await stopping;expect(stopped).toBe(true);
  });
});
describe('Codex 每调用结构化错误',()=>{
  it('显式代理同时注入大小写 HTTP 环境变量且不改写进程环境',()=>{
    const before=process.env.HTTPS_PROXY;
    const env=runtimeEnvironment({...config,proxyUrl:' http://127.0.0.1:7890 '});
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890/');expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890/');expect(env.ALL_PROXY).toBe('http://127.0.0.1:7890/');expect(env.http_proxy).toBe('http://127.0.0.1:7890/');
    expect(process.env.HTTPS_PROXY).toBe(before);
  });
  it('拒绝不支持的代理协议和明文认证信息',()=>{
    expect(()=>runtimeEnvironment({...config,proxyUrl:'ftp://127.0.0.1:21'})).toThrow('代理仅支持');
    expect(()=>runtimeEnvironment({...config,proxyUrl:'http://user:secret@127.0.0.1:7890'})).toThrow('不能包含用户名或密码');
  });
  it('Codex 子进程使用配置中的显式代理',async()=>{
    const process=child();mocks.spawn.mockReturnValue(process);const runtime=new CodexCliRuntime();await runtime.start('test-runtime',{...config,proxyUrl:'socks5://127.0.0.1:7891'});const pending=runtime.promptAndWait('s','prompt');await flushSpawn();
    expect(mocks.spawn.mock.calls.at(-1)?.[2].env).toMatchObject({HTTP_PROXY:'socks5://127.0.0.1:7891',HTTPS_PROXY:'socks5://127.0.0.1:7891',ALL_PROXY:'socks5://127.0.0.1:7891'});
    process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'OK'}})+'\n');process.emit('close',0);expect(await pending).toBe('OK');
  });
  it('结构化调用写入 schema 并交给 Codex CLI',async()=>{
    const process=child();mocks.spawn.mockReturnValue(process);const runtime=await started(),schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
    const pending=runtime.promptAndWait('details-F-003','prompt',60_000,[],schema);await flushSpawn();
    const args=mocks.spawn.mock.calls.at(-1)?.[1] as string[],schemaIndex=args.indexOf('--output-schema');expect(schemaIndex).toBeGreaterThan(0);expect(args[schemaIndex+1]).toContain('details-F-003.output-schema.json');
    expect(mocks.writeFile).toHaveBeenCalledWith(expect.stringContaining('details-F-003.output-schema.json'),JSON.stringify(schema),'utf8');
    process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}})+'\n');process.emit('close',0);expect(JSON.parse(await pending)).toEqual({ok:true});
  });
  it('中间重连error后turn.completed和答案成功不误判失败',async()=>{
    const process=child();mocks.spawn.mockReturnValue(process);const runtime=await started();const pending=runtime.promptAndWait('s','prompt');await flushSpawn();
    for(const event of [{type:'error',message:'temporary reconnect'},{type:'item.completed',item:{type:'agent_message',text:'OK'}},{type:'turn.completed',usage:{input_tokens:10,output_tokens:1}}])process.stdout.write(JSON.stringify(event)+'\n');process.emit('close',0);
    expect(await pending).toBe('OK');expect(runtime.diagnostics()).toBe('');expect(runtime.metrics()[0].inputTokens).toBe(10);
  });
  it('明确turn.failed即使退出码为0也失败',async()=>{
    const process=child();mocks.spawn.mockReturnValue(process);const runtime=await started();const pending=runtime.promptAndWait('s','prompt');const rejected=expect(pending).rejects.toThrow('terminal failure');await flushSpawn();process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'terminal failure'}})+'\n');process.emit('close',0);await rejected;
  });
  it('退出错误包含turn.failed具体原因，处理无结尾换行并屏蔽敏感字段',async()=>{
    const process=child();mocks.spawn.mockReturnValue(process);const runtime=await started();const pending=runtime.promptAndWait('s','prompt');const rejection=expect(pending).rejects.toThrow('额度不足');await flushSpawn();
    process.stderr.write('raw stderr SECRET-STDERR');process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'额度不足 token原因 CONFIG-SECRET api_key=EXPOSED Bearer abc.def user@example.com https://x.test/?token=URLSECRET'}}));process.emit('close',1);await rejection;
    expect(runtime.diagnostics()).not.toMatch(/SECRET|EXPOSED|abc\.def|user@example|x\.test/);expect(runtime.diagnostics()).toContain('额度不足');
  });
  it('并发失败原因只属于对应调用，不串联其他调用或stderr',async()=>{
    const a=child(),b=child();mocks.spawn.mockReturnValueOnce(a).mockReturnValueOnce(b);const runtime=await started();const first=runtime.promptAndWait('a','a').catch(e=>e as Error),second=runtime.promptAndWait('b','b').catch(e=>e as Error);await flushSpawn();
    a.stdout.write(JSON.stringify({type:'error',message:'A rate limit'})+'\n');b.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'B unavailable'}})+'\n');a.emit('close',1);b.emit('close',1);
    expect((await first as Error).message).toContain('A rate limit');expect((await first as Error).message).not.toContain('B unavailable');expect((await second as Error).message).toContain('B unavailable');expect((await second as Error).message).not.toContain('A rate limit');
  });
  it('没有结构化错误时不暴露原始stderr，成功调用不继承历史错误',async()=>{
    const a=child(),b=child();mocks.spawn.mockReturnValueOnce(a).mockReturnValueOnce(b);const runtime=await started();const failure=runtime.promptAndWait('a','a');const rejected=expect(failure).rejects.toThrow(/^Codex 已退出（1）$/);await flushSpawn();a.stderr.write('private prompt secret');a.emit('close',1);await rejected;
    const success=runtime.promptAndWait('b','b');await flushSpawn();b.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'OK'}})+'\n');b.emit('close',0);expect(await success).toBe('OK');expect(runtime.diagnostics()).toBe('');
  });
});
describe('Codex CLI 状态检查',()=>{
  it('macOS 从 PATH 发现无 exe 后缀的 Codex CLI',async()=>{
    if(process.platform!=='darwin')return;
    const originalPath=process.env.PATH,bin=path.join('/private/tmp/prd-codex-bin','codex');
    process.env.PATH=path.dirname(bin);
    mocks.access.mockImplementation(async candidate=>{if(candidate===bin)return;throw Object.assign(new Error('missing'),{code:'ENOENT'})});
    mocks.execFile.mockImplementation((_bin,args,_options,callback)=>callback(null,args[0]==='--version'?'codex-cli 0.154.0':'Logged in using ChatGPT',''));
    try{const result=await inspectRuntime(config);expect(result).toMatchObject({available:true,launcher:bin,version:'0.154.0',authStatus:'authenticated'})}
    finally{process.env.PATH=originalPath}
  });
  it.each([
    [null,'Logged in using ChatGPT','authenticated'],
    [new Error('exit 1'),'Not logged in','unauthenticated'],
    [new Error('timeout'),'','error'],
    [null,'unrecognized output','error'],
  ])('认证状态不混淆 %s %s',async(error,output,expected)=>{
    mocks.execFile.mockImplementation((_bin,args,_options,callback)=>{if(args[0]==='--version')callback(null,'codex-cli 0.153.4','');else callback(error,'',output)});
    const result=await inspectRuntime(config);
    expect(result.version).toBe('0.153.4');expect(result.authStatus).toBe(expected);expect(result.available).toBe(true);expect(result.routeReady).toBeUndefined();expect(JSON.stringify(result)).not.toContain('Logged in');
  });
  it('版本命令失败不把目录名当作版本',async()=>{
    mocks.execFile.mockImplementation((_bin,_args,_options,callback)=>callback(new Error('failed'),'','private data'));
    const result=await inspectRuntime(config);expect(result.version).toBeUndefined();expect(result.reason).toBe('CLI 版本检查失败');expect(JSON.stringify(result)).not.toContain('private data');
  });
});
