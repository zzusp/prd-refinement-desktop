// 无业务数据的真实 Codex CLI Schema 接受性探针；不修改认证和配置。
import {readFile,writeFile,mkdir,readdir,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import {z} from 'zod';
import {createHash} from 'node:crypto';
const root=process.cwd(),out=path.join(root,'docs/tmp/typed-node-execution',`schema-probe-${Date.now()}`);
const model=process.argv[2]??'gpt-5.6-terra';
await mkdir(out,{recursive:true});
const source=await readFile(path.join(root,'electron/model-output-schemas.ts'),'utf8');
await writeFile(path.join(out,'contracts.mjs'),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
const {nodeContracts,schemaToJson}=await import(pathToFileURL(path.join(out,'contracts.mjs')).href);
await writeFile(path.join(out,'runtime.mjs'),ts.transpileModule(await readFile(path.join(root,'electron/runtime.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
const {codexOutputContract}=await import(pathToFileURL(path.join(out,'runtime.mjs')).href);
const binRoot=path.join(process.env.LOCALAPPDATA,'OpenAI/Codex/bin');let bin;
for(const name of (await readdir(binRoot)).sort().reverse()){const candidate=path.join(binRoot,name,'codex.exe');try{await access(candidate);bin=candidate;break}catch{}}
if(!bin)throw new Error('缺少 Codex CLI');
const redacted=value=>value.replace(/https?:\/\/[^\s"<>]+/g,'[url]').replace(/\b(?:sk-|eyJ)[A-Za-z0-9_.-]+/g,'[secret]');
async function probe(name,contract){
 const startedAt=new Date().toISOString();
 const wire=codexOutputContract(schemaToJson(contract.proposal)),schema=wire.schema,schemaFile=path.join(out,`${name}.schema.json`);await writeFile(schemaFile,JSON.stringify(schema,null,2));
 const args=['exec','--json','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--ignore-user-config','--ignore-rules','-m',model,'-c','model_reasoning_effort="low"','--output-schema',schemaFile];
 for(const flag of ['apps','browser_use','computer_use','image_generation','memories','plugins','skill_search','shell_tool','unified_exec','workspace_dependencies','goals','multi_agent'])args.push('--disable',flag);
 args.push('-C',out,'-');
 const env={...process.env};delete env.CODEX_SESSION_ID;delete env.CODEX_THREAD_ID;delete env.CODEX_PERMISSION_PROFILE;
 const child=spawn(bin,args,{cwd:out,env,windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';const decoder=new StringDecoder('utf8');let timedOut=false;
 child.stdout.on('data',chunk=>stdout+=decoder.write(chunk));child.stderr.on('data',chunk=>stderr+=chunk.toString('utf8'));
 child.stdin.end('This is a schema transport test without any business data. Submit the smallest valid object allowed by the supplied schema. Prefer empty arrays. Use "x" for mandatory strings. Do not use tools.');
 const timer=setTimeout(()=>{timedOut=true;child.kill()},90000);
 const exitCode=await new Promise(resolve=>child.once('close',resolve));clearTimeout(timer);stdout+=decoder.end();
 const events=stdout.split('\n').filter(Boolean).flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}});
 const errors=events.filter(e=>e.type==='error'||e.type==='turn.failed').map(e=>redacted(e.error?.message??e.message??''));
 const answer=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').at(-1)?.item?.text;
 let localValid=false;try{localValid=contract.proposal.safeParse(wire.decode(JSON.parse(answer))).success}catch{}
 const result={name,startedAt,completedAt:new Date().toISOString(),model,schemaHash:createHash('sha256').update(JSON.stringify(schema)).digest('hex'),rootWrapped:schema!==schemaToJson(contract.proposal)&&schema.required?.[0]==='result',exitCode,timedOut,completed:events.some(e=>e.type==='turn.completed'),localValid,errors,stderr:redacted(stderr).slice(-1000)};
 await writeFile(path.join(out,`${name}.result.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result));return result;
}
const entries=[...Object.entries(nodeContracts),['root-union-probe',{proposal:z.union([z.strictObject({left:z.literal('x')}),z.strictObject({right:z.literal('x')})])}]];
const queue=process.argv[3]?entries.filter(([name])=>process.argv[3].split(',').includes(name)):entries,results=[];
await Promise.all(Array.from({length:3},async()=>{while(queue.length){const [name,contract]=queue.shift();results.push(await probe(name,contract))}}));
await writeFile(path.join(out,'summary.json'),JSON.stringify({bin,results},null,2));console.log(`OUTPUT=${out}`);
if(results.some(r=>!r.completed||!r.localValid))process.exitCode=1;
