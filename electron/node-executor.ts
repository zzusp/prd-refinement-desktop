import { createHash } from 'node:crypto';
import { RuntimeOperationError, type AnalysisRuntime, type RuntimeImage } from './runtime.js';
import type { NodeExecutionReceipt, NodeValidationIssue } from '../src/types.js';

type Schema = { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean; error?: { issues: Array<{code:string;path:PropertyKey[];message:string;errors?:unknown}> } } };
export interface NodeDefinition<T> {
  id: string;
  version: number;
  input: Schema;
  proposal: Schema;
  result: Schema;
  parameters: Record<string, unknown>;
  instructions: string;
  accept(value: Record<string, unknown>): T;
}
export class NodeExecutionError extends Error {
  constructor(readonly category: 'input'|'validation'|'result'|'interrupted', message:string, readonly issues:NodeValidationIssue[] = []) { super(message); this.name='NodeExecutionError'; }
}
export class CandidateValidationError extends Error {
  constructor(readonly issues:NodeValidationIssue[]) { super(issues.map(item=>`${item.path}: ${item.expected}（${item.actual}）`).join('；')); }
}
export function defineNode<T>(definition:NodeDefinition<T>):NodeDefinition<T> { return definition; }
function schemaIssues(schema:Schema,value:unknown):NodeValidationIssue[] {
  const parsed=schema.safeParse(value);
  return parsed.success?[]:(parsed.error?.issues??[]).map(issue=>({code:issue.code,path:issue.path.map(String).join('.'),expected:issue.message,actual:issue.errors?JSON.stringify({alternativeBranchErrors:issue.errors}):'不符合契约'}));
}
function inputReferenceIssues(value:unknown):NodeValidationIssue[] {
  if(!value||typeof value!=='object'||Array.isArray(value))return[];
  const input=value as {sourceUnits?:Array<{id:string}>;evidenceCatalog?:Array<{id:string;sourceUnitId:string;start:number;end:number}>;originalInput?:unknown};
  const issues:NodeValidationIssue[]=[],units=new Set<string>(),evidence=new Set<string>();
  for(const [index,unit] of (input.sourceUnits??[]).entries()){
    if(units.has(unit.id))issues.push({code:'duplicate-source',path:`sourceUnits.${index}.id`,expected:'唯一原文单元 ID',actual:unit.id});units.add(unit.id);
  }
  for(const [index,item] of (input.evidenceCatalog??[]).entries()){
    if(evidence.has(item.id))issues.push({code:'duplicate-evidence',path:`evidenceCatalog.${index}.id`,expected:'唯一证据 ID',actual:item.id});evidence.add(item.id);
    if(!units.has(item.sourceUnitId))issues.push({code:'unknown-source',path:`evidenceCatalog.${index}.sourceUnitId`,expected:'当前输入中的原文单元',actual:item.sourceUnitId});
    if(item.end<=item.start)issues.push({code:'invalid-span',path:`evidenceCatalog.${index}`,expected:'end 大于 start',actual:`${item.start}:${item.end}`});
  }
  if(input.originalInput)issues.push(...inputReferenceIssues(input.originalInput).map(issue=>({...issue,path:`originalInput.${issue.path}`})));
  return issues;
}
export interface NodeRunOptions {
  workItemId:string;
  executionId:string;
  input:unknown;
  runtime:()=>Promise<AnalysisRuntime>;
  configuration:unknown;
  receipts:Record<string,NodeExecutionReceipt>;
  save():Promise<void>;
  assert():void;
  signal?:AbortSignal;
  images?:RuntimeImage[];
  timeoutMs?:number;
  onAttempt?(attempt:number,request:string,operationId:string):Promise<void>;
  onInvalid?(attempt:number,candidate:unknown,issues:NodeValidationIssue[]):Promise<void>;
}
const commitBarriers=new WeakMap<object,Map<string,Promise<void>>>();
async function withWorkItem<T>(receipts:object,key:string,work:()=>Promise<T>):Promise<T>{
  let barriers=commitBarriers.get(receipts);if(!barriers){barriers=new Map();commitBarriers.set(receipts,barriers)}
  const previous=barriers.get(key)??Promise.resolve();let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve}),tail=previous.then(()=>gate);barriers.set(key,tail);
  await previous;
  try{return await work()}finally{release();if(barriers.get(key)===tail)barriers.delete(key)}
}

/** 只在成功回执落盘后返回。失败候选永不成为下游输入。 */
export async function executeNode<T>(node:NodeDefinition<T>,options:NodeRunOptions):Promise<T> {
  const guard=()=>{options.signal?.throwIfAborted();options.assert();};
  guard();
  const inputIssues=schemaIssues(node.input,options.input);
  if(inputIssues.length)throw new NodeExecutionError('input',`${node.id} 平台入参不符合契约：${inputIssues.map(issue=>`${issue.path} ${issue.expected}`).join('；')}`,inputIssues);
  const input=node.input.parse(options.input);
  const referenceIssues=inputReferenceIssues(input);
  if(referenceIssues.length)throw new NodeExecutionError('input',`${node.id} 平台输入引用无效：${referenceIssues.map(issue=>`${issue.path} ${issue.actual}`).join('；')}`,referenceIssues);
  const inputHash=createHash('sha256').update(JSON.stringify({node:node.id,version:node.version,input,instructions:node.instructions,configuration:options.configuration,images:options.images})).digest('hex');
  const key=`${node.id}:${options.workItemId}:${inputHash}`;
  return withWorkItem(options.receipts,key,()=>executePreparedNode(node,options,input,inputHash,key));
}
async function executePreparedNode<T>(node:NodeDefinition<T>,options:NodeRunOptions,input:unknown,inputHash:string,key:string):Promise<T>{
  const guard=()=>{options.signal?.throwIfAborted();options.assert();};guard();
  let receipt=options.receipts[key];
  if(receipt?.status==='succeeded') {
    if(schemaIssues(node.result,receipt.result).length)throw new NodeExecutionError('result',`${node.id} 成功回执损坏`);
    guard();return structuredClone(receipt.result) as T;
  }
  if(!receipt)receipt=options.receipts[key]={nodeId:node.id,contractVersion:node.version,workItemId:options.workItemId,inputHash,input,status:'running',attempts:[]};
  let run=receipt.attempts.find(item=>item.executionId===options.executionId);
  if(!run){run={executionId:options.executionId,calls:0,transientRetries:0,protocolRetries:0,repairs:0,status:'running',candidates:[]};receipt.attempts.push(run)}
  if(run.status==='failed')throw new NodeExecutionError('interrupted',run.error??`${node.id} 本次尝试已耗尽，请显式重试`);
  // 进程中断后的 running 调用没有完成证明；不得当作新调用无限重放。
  if(run.inFlight) {run.status='failed';run.error='上次模型调用缺少完成回执，请显式重试';await options.save();throw new NodeExecutionError('interrupted',run.error)}
  receipt.status='running';await options.save();
  const fail=async(error:unknown):Promise<never>=>{guard();run!.status='failed';run!.error=error instanceof Error?error.message:String(error);receipt!.status='failed';await options.save();throw error;};
  while(true){
    guard();
    const last=run.candidates.at(-1);
    const repair=last?.issues?.length?{previousCandidate:last.value,issues:last.issues}:undefined;
    const instructions=node.instructions+(repair?'\n上次候选未通过验收。请根据 previousCandidate 和 issues 一次修正全部问题，重新提交完整候选；原始 input 仍是唯一依据。':'');
    const requestInput=repair?{input, ...repair}:input;
    const operationId=`${options.executionId}-${options.workItemId}-${inputHash.slice(0,16)}-try${run.calls+1}`;
    let candidate:Record<string,unknown>;
    try {
      // capability/init failure is classified before setting an in-flight operation.
      const runtime=await options.runtime();guard();
      await options.onAttempt?.(run.calls+1,`${instructions}\n节点输入：${JSON.stringify(requestInput)}`,operationId);guard();
      run.calls++;run.inFlight=true;await options.save();guard();
      const response=await runtime.executeOperation({operationId,instructions,input:requestInput,submission:{name:`submit_${node.id.replace(/[^a-zA-Z0-9_]/g,'_')}`,description:`提交 ${node.id} 候选结果`,parameters:node.parameters},signal:options.signal,images:options.images,timeoutMs:options.timeoutMs});
      guard();run.inFlight=false;
      if(response.completion!=='completed')throw new RuntimeOperationError('protocol','模型操作没有完整结束');
      candidate=response.value;
      if(response.usage)(run.usage??=[]).push(response.usage);
    } catch(error) {
      guard();run.inFlight=false;
      (run.errors??=[]).push({code:error instanceof RuntimeOperationError?error.code:'platform',message:error instanceof Error?error.message:String(error),at:Date.now()});
      if(error instanceof RuntimeOperationError&&error.response!==undefined){
        const issues=[{code:'protocol',path:'candidate',expected:'完整的结构化参数对象',actual:error.message}];
        run.candidates.push({value:error.response,issues,at:Date.now()});
        await options.onInvalid?.(run.calls,error.response,issues);guard();
      }
      if(error instanceof RuntimeOperationError&&error.code==='transient'&&run.transientRetries<2){run.transientRetries++;await options.save();continue}
      if(error instanceof RuntimeOperationError&&error.code==='protocol'&&run.protocolRetries<1){run.protocolRetries++;await options.save();continue}
      return fail(error);
    }
    const attempt={value:structuredClone(candidate),issues:schemaIssues(node.proposal,candidate),at:Date.now()};run.candidates.push(attempt);await options.save();guard();
    let result:T|undefined;
    if(!attempt.issues.length){
      try {result=node.accept(node.proposal.parse(candidate) as Record<string,unknown>)}
      catch(error){if(error instanceof CandidateValidationError)attempt.issues=error.issues;else return fail(error)}
    }
    if(attempt.issues.length){
      await options.onInvalid?.(run.calls,candidate,attempt.issues);guard();
      if(run.repairs>=2)return fail(new NodeExecutionError('validation',attempt.issues.map(issue=>`${issue.path}: ${issue.expected}；${issue.actual}`).join('\n'),attempt.issues));
      run.repairs++;await options.save();continue;
    }
    const resultIssues=schemaIssues(node.result,result);
    if(resultIssues.length)return fail(new NodeExecutionError('result',`${node.id} 平台正式结果不符合契约：${resultIssues.map(issue=>`${issue.path} ${issue.expected}`).join('；')}`,resultIssues));
    guard();receipt.result=structuredClone(result);receipt.status='succeeded';run.status='succeeded';
    try {await options.save();guard()} catch(error) {delete receipt.result;receipt.status='failed';run.status='failed';throw error}
    return structuredClone(result) as T;
  }
}
