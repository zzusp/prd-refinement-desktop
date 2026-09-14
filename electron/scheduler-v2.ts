import { SourceIndex } from './source-index.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisInputApplication, AnalysisTask, AuditIssue, Clarification, DeliveryAssessment, Feature, ModelNodeId, PrdProject, RepairReview, RepairTargetResult, RuntimeConfig, RuntimeConfigSnapshot, SourceDisposition, SourceUnit } from '../src/types.js';
import { applyRequirementPatch, acceptRequirementPatch, planDetailRepairs } from './audit-repair.js';
import { acceptCandidateClassificationIssues, acceptDirectAuditIssues, acceptDirectDetails, acceptDirectFeatureBatch, acceptFeatureUnification, acceptRequirementRelations, validateDirectGraph } from './domain.js';
import { writeAgentPackage } from './export-agent-package.js';
import { RefinementAdjustmentEngine } from './refinement-adjustments.js';
import { createRuntime, ensureStructuredCapability, type AnalysisRuntime, type RuntimeImage } from './runtime.js';
import { buildSourceUnits, enrichSourceContext, sourceCoverage } from './source-units.js';
import { DetailEvidenceValidationError, evidencePromptInput, materializeDetailEvidenceSelections, materializeEvidenceSelections, type SourceEvidence } from './source-evidence.js';
import {checksPass, closeIssue, contentFingerprint, projectInputHash, registerAuditIssues, requiredChecks} from './task-execution-state.js';
import {attemptTimeoutMs,budgetClassFor,measurePrompt} from './prompt-budget.js';
import {nodeContracts, schemaToJson, type NodeContractId} from './model-output-schemas.js';
import {executeNode, CandidateValidationError, NodeExecutionError} from './node-executor.js';
import {DomainValidationError} from './node-validation.js';

class CandidateClassificationError extends Error {
  constructor(readonly issues: ReturnType<typeof acceptCandidateClassificationIssues>) { super('统一发现候选分类错误，需要定点重分类'); }
}
class ModelOutputValidationError extends Error {
  stepIndex?:number;purpose?:string;title?:string;
  constructor(message:string,readonly validationCause:unknown){super(message);this.name='ModelOutputValidationError'}
}

type Emit = (task: AnalysisTask) => void;
const stages = [
  ['inventory', '原文建账', '登记原文、结构、位置与缺失材料'],
  ['candidates', '功能内容整理', '按连贯原文包整理功能内容'],
  ['unify', '功能清单整理', '合并重复功能并保留跨功能约束'],
  ['details', '逐功能细化', '整理原文明示的简短需求清单'],
  ['audit', '产物依据核查', '核查需求表述是否忠于原文'],
  ['repair', '有据修正', '对无依据或曲解原文的内容进行一次定点修正'],
  ['delivery', '结果生成', '保存功能模块、需求清单与原文入口'],
] as const;
const featureSchema = '{"id":"LOCAL-F1","name":"简短、可区分的业务功能名称","kind":"function|constraint","evidenceIds":["从 evidenceCatalog 选择，不得自造"],"appliesToFeatureIds":["仅 kind=constraint 时填写；kind=function 必须返回空数组"]}';
const unifiedFeatureSchema = '{"id":"LOCAL-F1","name":"简短、可区分的业务功能名称","kind":"function|constraint","appliesToFeatureIds":["仅 kind=constraint 时填写；kind=function 必须返回空数组"]}';
const candidateSchema = `{"features":[${featureSchema}],"sourceDispositions":[{"sourceUnitId":"S-001","contentRole":"requirement|context|example|summary|out-of-scope","reason":"...","featureIds":["LOCAL-F1"]}]}。contentRole只表示该段原文在分析中的作用；原文明示业务要求使用 requirement，未形成明确要求的问题使用 context；是否为跨功能约束由 features[].kind 单独表达。普通功能不得声明适用目标：kind=function 时 appliesToFeatureIds 必须为 []；只有 kind=constraint 才能填写目标功能 ID。`;
const detailSchema = '{"requirements":[{"id":"LOCAL-R1","text":"撤回未审核申请","evidenceIds":["E1"]}]}。只生成简短需求检查项，保留原文必要否定与范围限定；不生成待处理事项、阻塞分析、建议、澄清或独立条件字段。模型不得输出 sourceRefs、sourceUnitIds、state 或字符位置，来源及所属功能由程序生成';
const auditSchema = '{"issues":[{"id":"LOCAL-A1","direction":"forward|reverse|cross","type":"...","category":"rule-extraction|feature-boundary|detail-mismatch|unclassified","owner":"feature-grouping|requirement-detail|requirement-relation|runtime-output","sourceUnitIds":["S-001"],"affectedIds":["R-0001"],"detail":"清单与原文不一致的具体位置"}],"relations":[{"id":"LOCAL-REL-1","sourceRequirementId":"R-0001","targetRequirementId":"R-0002","kind":"depends-on|affects|exception-to","evidenceIds":["E1"]}]}。issues 仅记录平台生成清单与原文不一致的错误，不分析业务阻塞，不生成待处理事项、建议或澄清。引用输入中的真实编号；关系仅限原文明示的已有需求关系，不推导实施顺序。';
const repairReviewSchema = `{"originalIssueResults":[{"issueId":"输入问题ID","status":"resolved|unresolved","reason":"逐项说明指定缺口是否解决"}],"introducedIssues":[${auditSchema.slice(auditSchema.indexOf('{"id"'),auditSchema.indexOf('}],"relations"')+1)}],"discoveredIssues":[${auditSchema.slice(auditSchema.indexOf('{"id"'),auditSchema.indexOf('}],"relations"')+1)}]}。introducedIssues 只报告候选相对 before 新引入的回归；discoveredIssues 只报告修改前就存在、但不属于 originalIssues 的旁支问题。旁支问题不得冒充回归，也不得把原问题重复放入 discoveredIssues。`;
const fastNodes = new Set<ModelNodeId>(['inputInterpretation', 'featureCandidates', 'detailsFast']);
const sourceClassificationContract = '统一来源分类契约：仅数量统计或章节索引、未表达具体业务行为的摘要归为 context，不需要独立功能，检查不得要求为其创建功能，统一不得因其未独立成项重复反馈。摘要若包含正文未展开的具体业务要求，必须保留并关联实际功能；不能因位于摘要就丢弃。文档记法和纯表头归为 context；标题或摘要明确的新增模块、字段重命名等业务要求必须保留。';
const nodeStep: Record<ModelNodeId, number> = { imageReading: 0, inputInterpretation:0, featureCandidates: 1, featureCandidateRepair: 1, featureGlobal: 2, detailsFast: 3, details: 3, audit: 4, repair: 5 };
export const CURRENT_PIPELINE_VERSION = 27;

interface NodeCall<T> {
  contract:NodeContractId;node:ModelNodeId;purpose:string;title:string;instruction:string;input:unknown;
  accept(value:Record<string,unknown>):T;images?:RuntimeImage[];preparedEvidence?:boolean;
  materialize?:(value:Record<string,unknown>,catalog:SourceEvidence[])=>Record<string,unknown>;
}
function acceptCandidate<T>(accept:()=>T):T {
  try{return accept()}catch(error){
    if(error instanceof DetailEvidenceValidationError)throw new CandidateValidationError(error.issues);
    if(error instanceof DomainValidationError)throw new CandidateValidationError(error.issues);
    throw error;
  }
}
export function attachInitialUserInput(project:PrdProject){
  const input=project.analysisInput?.text.trim();if(!input)return [] as SourceUnit[]; const result:SourceUnit[]=[];
  const existing=new Set(project.sourceUnits.filter(unit=>unit.synthetic&&unit.location.startsWith('用户补充 · 本次分析')).map(unit=>unit.excerpt));
  const sentences=input.split(/(?<=[。！？；!?;])|\n+/u).map(value=>value.trim()).filter(Boolean);
  const parts=sentences.flatMap(sentence=>{
    const clauses=sentence.split(/(?<=[，,])/u).map(value=>value.trim()).filter(Boolean);
    const scopeClauses=clauses.filter(value=>/(本期|此次|当前版本|暂不|不做|纳入|排除|只做)/u.test(value));
    return scopeClauses.length>1&&scopeClauses.length===clauses.length?clauses:[sentence];
  });
  for(const [index,excerpt] of parts.entries()){
    if(existing.has(excerpt))continue;
    result.push({id:`USER-${project.analysisInput!.fingerprint.slice(0,12)}-${String(index+1).padStart(3,'0')}`,label:'用户补充说明',kind:'paragraph',excerpt,context:'这是用户为本次分析明确提交的原话。逐句判断其作用：所有输入均非PRD事实；颗粒度、组织和表达要求只改变整理方式；疑问句保持为待回答问题；新增规则须同步PRD。不得把整理要求或疑问改写成业务规则。',location:`用户补充 · 本次分析 · ${project.analysisInput!.submittedAt}`,status:'processed',sourceRole:'supplement',synthetic:true});
  }
  return result;
}
function acceptInputApplications(value:unknown,units:SourceUnit[]):AnalysisInputApplication[]{
  if(!Array.isArray(value))throw new DomainValidationError('用户输入应用记录缺少 entries');
  const allowed=new Map(units.map(unit=>[unit.id,unit]));
  const seen=new Set<string>();
  const entries=value.map((raw,index)=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new DomainValidationError(`entries[${index}] 结构无效`);
    const item=raw as Record<string,unknown>,sourceUnitId=typeof item.sourceUnitId==='string'?item.sourceUnitId:'';
    if(!allowed.has(sourceUnitId)||seen.has(sourceUnitId))throw new DomainValidationError(`entries[${index}].sourceUnitId 无效或重复`);seen.add(sourceUnitId);
    const kind=item.kind,summary=typeof item.summary==='string'?item.summary.trim():'';
    if(!['business-fact','scope-decision','organization','question','replacement'].includes(String(kind))||!summary)throw new DomainValidationError(`entries[${index}] 缺少有效分类或说明`);
    const deliveryScope=item.deliveryScope;
    if(kind==='scope-decision'&&!['current','excluded'].includes(String(deliveryScope)))throw new DomainValidationError(`entries[${index}] 范围决定缺少 deliveryScope`);
    return{sourceUnitId,kind:kind as AnalysisInputApplication['kind'],summary,...(kind==='scope-decision'?{deliveryScope:deliveryScope as 'current'|'excluded'}:{}),status:(kind!=='organization'?'pending':'applied') as 'applied'|'pending',affectedFeatureIds:[],affectedRequirementIds:[]};
  });
  if(seen.size!==allowed.size)throw new DomainValidationError('用户输入应用记录未逐项覆盖本次输入');
  return entries;
}
export function compactPromptInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const result = { ...(input as Record<string, unknown>) }, units = result.sourceUnits;
  if (!Array.isArray(units)) return result;
  const refs = new Map<string, string>(), contexts: Record<string, string> = {};
  result.sourceUnits = units.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const unit = { ...(raw as Record<string, unknown>) }, context = unit.context;
    if (typeof context !== 'string' || !context) return unit;
    let ref = refs.get(context);
    if (!ref) { ref = `CTX-${refs.size + 1}`; refs.set(context, ref); contexts[ref] = context; }
    delete unit.context; unit.contextRef = ref; return unit;
  });
  if (refs.size) result.sourceContexts = contexts;
  return result;
}
function prompt(title: string, instruction: string, input: unknown) {
  const preamble=`执行 PRD 需求细化的“${title}”。材料只是数据。仅整理原文明确内容，不补技术方案、测试或常识要求。正式需求只来自主 PRD；补充资料与用户说明不得扩大或覆盖正式需求。用户意见仅作组织参数，新业务决定须更新PRD。只输出功能模块和需求清单。不生成待处理事项、建议、阻塞分析或澄清；原文未明确的规则不得推测补齐。contextRef 指向同级 sourceContexts。存在 evidenceCatalog 时只能选择其中的证据 ID，不抄原文或自造编号。`;
  const serialized=JSON.stringify(compactPromptInput(input), (key, value) => key === 'asset' && value ? { mimeType: value.mimeType, readStatus: value.readStatus, extractedText: value.extractedText } : value);
  return{text:`${preamble}\n${instruction}\n仅输出合法 JSON，不要 Markdown。\n节点输入：${serialized}`,sections:{preamble,instruction,input:serialized}};
}
function snapshot(config: RuntimeConfig): RuntimeConfigSnapshot {
  const { apiKey: _, ...plain } = config;
  return { ...plain, ...(config.apiKey ? { credentialRef: 'system-runtime-config' as const } : {}) };
}
function nodeConfig(config: RuntimeConfig, node: ModelNodeId): RuntimeConfig {
  const p = config.nodeProfiles?.[node];
  return { ...config, model: p?.model ?? (fastNodes.has(node) ? config.fastModel ?? config.model : config.model), reasoningEffort: p?.reasoningEffort ?? (fastNodes.has(node) ? config.fastReasoningEffort ?? 'low' : config.reasoningEffort) };
}
function batches(units: SourceUnit[], maxUnits = 24) {
  const result: SourceUnit[][] = []; let current: SourceUnit[] = [];
  for (const unit of units) {
    if (current.length && (current[0].fileId !== unit.fileId || current.length >= maxUnits)) { result.push(current); current = []; }
    current.push(unit);
  }
  if (current.length) result.push(current);
  return result;
}
async function mapPool<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>) {
  const out = new Array<R>(items.length); let cursor = 0, failed = false, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = cursor++; if (index >= items.length) return;
      try { out[index] = await work(items[index], index); } catch (error) { if (!failed) failure = error; failed = true; }
    }
  }));
  if (failed) throw failure;
  return out;
}
export function detailIsComplex(_feature: Feature, units: SourceUnit[]) {
  const text = units.map(u => `${u.excerpt}\n${u.asset?.extractedText ?? ''}`).join('\n');
  // 常见的“必填/默认/校验”本身不触发升级。
  return text.length > 12000 || /(联动|宽限期|迁移|跨功能|优先级|状态转换|状态变化|例外|互斥|仅当|除非)/.test(text);
}
function nextId(prefix: string, items: Array<{ id: string }>, width: number) {
  const maximum = items.reduce((n, item) => Math.max(n, Number(item.id.startsWith(prefix) ? item.id.slice(prefix.length) : 0) || 0), 0);
  return `${prefix}${String(maximum + 1).padStart(width, '0')}`;
}
export function semanticallyRelatedRequirements(query:string,requirements:PrdProject['requirements'],limit=4){
  const grams=(value:string)=>{const normalized=value.toLocaleLowerCase('zh-CN').replace(/[\s，。；：、,.!?！？:「」“”'"`()（）【】\[\]<>《》]/gu,'');const result=new Set<string>();for(let index=0;index<normalized.length-1;index++)result.add(normalized.slice(index,index+2));return result};
  const queryGrams=grams(query);if(!queryGrams.size)return[];
  const documents=requirements.map(requirement=>({requirement,grams:grams(requirement.text)})),frequency=new Map<string,number>();
  for(const document of documents)for(const gram of document.grams)frequency.set(gram,(frequency.get(gram)??0)+1);
  return documents.map(document=>{const matches=[...document.grams].filter(gram=>queryGrams.has(gram)),weighted=matches.reduce((score,gram)=>score+Math.log(1+documents.length/(frequency.get(gram)??1)),0),score=weighted/Math.sqrt(Math.max(1,document.grams.size));return{requirement:document.requirement,matches:matches.length,score}}).filter(item=>item.matches>=2).sort((a,b)=>b.score-a.score||a.requirement.id.localeCompare(b.requirement.id)).slice(0,limit).map(item=>item.requirement);
}
function mergeConfirmationScopes(scopes:ReturnType<typeof planDetailRepairs>){
  const grouped=new Map<string,(typeof scopes)[number]>();
  for(const scope of scopes){const key=[...scope.featureIds].sort().join('|'),current=grouped.get(key);if(!current){grouped.set(key,structuredClone(scope));continue}current.issues.push(...scope.issues);for(const field of ['featureIds','requirementIds','clarificationIds','sourceUnitIds','requiredSourceUnitIds','readOnlyRequirementIds'] as const)current[field]=[...new Set([...(current[field]??[]),...(scope[field]??[])])];current.key=current.issues.map(issue=>issue.id).sort().join('+')}
  return[...grouped.values()];
}
function combineDetailBatches(results:Array<{requirements:PrdProject['requirements'];clarifications:Clarification[]}>){
  const requirements:PrdProject['requirements']=[];
  results.forEach((result,index)=>{const suffix=`-B${index+1}`;requirements.push(...result.requirements.map(item=>({...item,id:item.id.startsWith('LOCAL-')?`${item.id}${suffix}`:item.id})))});
  return{requirements,clarifications:[] as Clarification[]};
}
export function featureAuditScope(project:PrdProject,feature:Feature){
  const requirementIds=new Set(feature.requirementIds);
  const requirements=project.requirements.filter(item=>requirementIds.has(item.id));
  return{requirements,sourceUnitIds:[...new Set(requirements.flatMap(item=>item.sourceRefs.map(ref=>ref.sourceUnitId)))]};
}
function routeUnownedSourceIssues(project:PrdProject,issues:AuditIssue[]){
  const ownedSources=new Set(project.features.flatMap(feature=>feature.sourceUnitIds));
  for(const issue of issues)if(issue.type==='原文来源未落实'&&issue.sourceUnitIds.every(id=>!ownedSources.has(id))){issue.category='feature-boundary';issue.owner='feature-grouping'}
}
function acceptRepairReview(value:Record<string,unknown>,issues:AuditIssue[],units:SourceUnit[],features:Feature[],requirements:PrdProject['requirements'],clarifications:Clarification[],relations:PrdProject['relations']=[]):RepairReview{
  if(!Array.isArray(value.originalIssueResults))throw new DomainValidationError('局部复核必须逐项返回 originalIssueResults');
  const expected=new Set(issues.map(issue=>issue.id)),seen=new Set<string>();
  const originalIssueResults:RepairTargetResult[]=value.originalIssueResults.map((raw,index)=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new DomainValidationError(`originalIssueResults[${index}] 必须为对象`);
    const item=raw as Record<string,unknown>,issueId=typeof item.issueId==='string'?item.issueId:'',status=item.status;
    if(!expected.has(issueId)||seen.has(issueId))throw new DomainValidationError(`局部复核引用无效或重复问题 ${issueId}`);seen.add(issueId);
    if(status!=='resolved'&&status!=='unresolved')throw new DomainValidationError(`局部复核 ${issueId} 状态非法`);
    if(typeof item.reason!=='string'||!item.reason.trim())throw new DomainValidationError(`局部复核 ${issueId} 缺少判断依据`);
    return{issueId,status,reason:item.reason};
  });
  if(seen.size!==expected.size)throw new DomainValidationError('局部复核没有逐项判断全部原问题');
  return{
    originalIssueResults,
    introducedIssues:acceptDirectAuditIssues(value.introducedIssues??[],units,features,requirements,clarifications,relations),
    discoveredIssues:acceptDirectAuditIssues(value.discoveredIssues??[],units,features,requirements,clarifications,relations),
  };
}
const featureContent = (f: Feature) => JSON.stringify([f.name, f.kind ?? 'function', [...(f.sourceRefs??f.sourceUnitIds.map(sourceUnitId=>({sourceUnitId})))].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))), [...(f.appliesToFeatureIds ?? [])].sort()]);
const deliveryProjection = (p:PrdProject) => ({sourceHash:p.sourceHash,revision:p.revision,features:p.features,requirements:p.requirements,relations:p.relations??[],clarifications:p.clarifications,audit:p.audit,sourceDispositions:p.sourceDispositions});
export const schedulerConcurrency = (config:Pick<RuntimeConfig,'maxParallel'|'maxNodeParallel'>) => {
  const taskLimit = Math.min(8, Math.max(1, Math.trunc(config.maxParallel) || 1));
  const nodeLimit = Math.min(10, Math.max(1, Math.trunc(config.maxNodeParallel ?? 10)));
  return { taskLimit, nodeLimit, slotLimit: taskLimit * nodeLimit };
};
const assessDelivery = (p:PrdProject,checks?:NonNullable<AnalysisTask['checkpoint']>['checks'],resultVersion=0):DeliveryAssessment => {
  const issues=(p.audit?.issues??[]).filter(i=>i.disposition!=='repaired'&&i.disposition!=='dismissed');
  const unverified=checksPass(checks,resultVersion)?[]:['source','feature','detail','relation'].filter(id=>checks?.[id as keyof typeof checks]?.status!=='passed'||checks?.[id as keyof typeof checks]?.resultVersion!==resultVersion);
  const state=issues.length?'blocked':unverified.length||!p.audit?.passed?'unchecked':'ready';
  return{state,inputHash:projectInputHash(p),resultHash:createHash('sha256').update(JSON.stringify(deliveryProjection(p))).digest('hex'),issueIds:issues.map(i=>i.id),unverifiedScopeIds:unverified,policyVersion:2};
};

export class AnalysisTaskScheduler {
  private tasks = new Map<string, AnalysisTask>();
  private queue: string[] = [];
  private running = new Map<string, AnalysisRuntime[]>();
  private writes = new Map<string, Promise<void>>();
  private pumping = false;
  private slots = 0;
  private slotLimit = 3;
  private slotQueue: Array<() => void> = [];
  private familyCommits = new Map<string, Promise<void>>();
  private deletedFamilies = new Set<string>();
  constructor(private root: string, private getConfig: () => Promise<RuntimeConfig>, private emit: Emit, private runtimeFactory: (config: RuntimeConfig) => AnalysisRuntime = createRuntime) {}

  async initialize() {
    await mkdir(this.root, { recursive: true });
    const storedFiles=await readdir(this.root);
    for(const file of storedFiles.filter(item=>item.startsWith('.deleted-')&&item.endsWith('.json')))try{const value=JSON.parse(await readFile(path.join(this.root,file),'utf8')) as {rootTaskId?:string};if(value.rootTaskId)this.deletedFamilies.add(value.rootTaskId)}catch{/* 损坏标记不参与推断 */}
    for (const file of storedFiles) {
      if (!/^T-[A-Z0-9]+\.json$/.test(file)) continue;
      let task: AnalysisTask;
      try { task = JSON.parse(await readFile(path.join(this.root, file), 'utf8')) as AnalysisTask; } catch { continue; }
      if (!task.id || !task.project || !Array.isArray(task.steps)) continue;
      if(this.deletedFamilies.has(task.rootTaskId??task.id))continue;
      if(task.status==='needs-attention'&&task.steps.length>0&&task.steps.every(step=>step.status==='completed')){task.status='completed';task.progress=100;task.error=undefined}
      if (task.checkpoint?.pipelineVersion !== CURRENT_PIPELINE_VERSION && !['completed','needs-attention'].includes(task.status)) {
        task.status = 'failed'; task.error = '旧版检查点仅供查看，请用原始材料创建新任务';
      } else if (task.status === 'running') {
        task.status = 'queued'; task.error = '应用退出后从最近检查点恢复';
        for (const step of task.steps) if (step.status === 'running') { step.status = 'pending'; step.startedAt = undefined; }
      }
      this.tasks.set(task.id, task);
      if (task.status === 'queued') this.queue.push(task.id);
      await this.save(task);
    }
    const families=new Map<string,AnalysisTask[]>();for(const task of this.tasks.values()){const root=task.rootTaskId??task.id;families.set(root,[...(families.get(root)??[]),task])}
    for(const family of families.values()){const formed=family.filter(task=>['completed','needs-attention'].includes(task.status)&&task.project.features.length).sort((a,b)=>a.createdAt-b.createdAt);if(formed.some(task=>task.resultVersion===undefined))formed.forEach((task,index)=>{task.resultVersion=index+1});for(const task of formed){if(!task.artifacts?.length)task.artifacts=await this.discoverArtifacts(task);await this.save(task)}}
    void this.pump();
  }
  list() { return [...this.tasks.values()].filter(task=>!task.archivedAt&&!this.deletedFamilies.has(task.rootTaskId??task.id)).sort((a, b) => b.createdAt - a.createdAt).map(t => structuredClone(t)); }
  listArchived() { return [...this.tasks.values()].filter(task=>task.archivedAt&&!this.deletedFamilies.has(task.rootTaskId??task.id)).sort((a,b)=>(b.archivedAt??0)-(a.archivedAt??0)).map(task=>structuredClone(task)); }
  get(id: string) { const task = this.tasks.get(id); return task ? structuredClone(task) : undefined; }
  getByOperationId(operationId:string) { const task=[...this.tasks.values()].find(item=>item.operationId===operationId);return task?structuredClone(task):undefined; }
  async create(input: PrdProject,lineage?:Pick<AnalysisTask,'rootTaskId'|'parentTaskId'|'resultVersion'|'adjustment'>,operationId?:string,requestedAt?:number) {
    if(operationId){const repeated=[...this.tasks.values()].find(task=>task.operationId===operationId);if(repeated)return structuredClone(repeated)}
    const config = await this.getConfig(), now = Date.now(), id=`T-${randomUUID().slice(0, 8).toUpperCase()}`;
    const task: AnalysisTask = {
      id, operationId, rootTaskId:lineage?.rootTaskId??id, parentTaskId:lineage?.parentTaskId, resultVersion:lineage?.resultVersion, adjustment:lineage?.adjustment, project: { ...structuredClone(input), sourceDispositions: [], rules: [], features: [], requirements: [], clarifications: [], audit: undefined },
      runtimeConfig: snapshot(config), attempt: 1, checkpoint: { pipelineVersion: CURRENT_PIPELINE_VERSION, resultVersion:0,promptMetrics:[],detailedFeatureIds:[],auditIssues:[],featureCandidateBatches:[],sourceDispositionBatches:[],candidateRepairRounds:[],unificationFeedback:[],detailResults:{},auditIssueBatches:[],relationBatches:[],validationFailures:[] },
      status: 'queued', progress: 0, createdAt: now, requestedAt:requestedAt??now, steps: stages.map(([id, name, note]) => ({ id, name, note, status: 'pending' })),
    };
    this.tasks.set(task.id, task); this.queue.push(task.id); await this.publish(task); void this.pump(); return structuredClone(task);
  }
  async enqueueAdjustment(request: import('../src/types.js').RefinementAdjustmentRequest) {
    const operationId=request.operationId?.trim()||randomUUID();
    const repeated=[...this.tasks.values()].find(task=>task.operationId===operationId);
    if(repeated)return structuredClone(repeated);
    const base=this.tasks.get(request.baseTaskId);
    if(!base||base.archivedAt||!['completed','needs-attention'].includes(base.status)||!base.project.features.length)throw new Error('基础结果不存在、已归档或尚不可调整');
    const rootTaskId=base.rootTaskId??base.id,latest=this.latestResult(rootTaskId);
    const baseVersion=base.resultVersion??1;
    if(!latest||latest.id!==base.id||request.baseVersion!==baseVersion)throw new Error(`结果已更新到第 ${latest?.resultVersion??baseVersion} 版，请在最新版上重新提交`);
    if(request.acceptedProposals?.length||request.acceptedProposalIds?.length||request.references?.some(item=>item.kind==='clarification'))throw new Error('当前版本仅支持功能与需求清单调整，请移除建议或澄清引用');
    if(base.checkpoint?.pipelineVersion!==CURRENT_PIPELINE_VERSION)throw new Error('旧版结果仅供查看，请用原始材料创建新任务');
    if(!request.feedback.trim())throw new Error('调整说明不能为空');
    const config=await this.getConfig(),now=Date.now(),id=`T-${randomUUID().slice(0,8).toUpperCase()}`;
    const persistedProject=structuredClone(base.project);
    const task:AnalysisTask={
      id,operationId,rootTaskId,parentTaskId:base.id,baseResultVersion:baseVersion,
      adjustment:{feedback:request.feedback.trim(),references:request.references},
      project:persistedProject,runtimeConfig:snapshot(config),attempt:1,
      checkpoint:{pipelineVersion:CURRENT_PIPELINE_VERSION,resultVersion:base.checkpoint?.resultVersion??0,promptMetrics:[],detailedFeatureIds:[],auditIssues:[],validationFailures:[]},
      status:'queued',progress:0,createdAt:now,
      steps:stages.map(([stepId,name,note],index)=>index<3?{id:stepId,name,note,status:'completed' as const,startedAt:now,completedAt:now}:index===3?{id:stepId,name:'按反馈重新生成',note:'用户输入已保存，等待解析、生成与依据核查',status:'pending' as const}:{id:stepId,name,note,status:'pending' as const}),
    };
    this.tasks.set(id,task);this.queue.push(id);await this.publish(task);void this.pump();return structuredClone(task);
  }
  private latestResult(rootTaskId:string){
    return [...this.tasks.values()].filter(task=>(task.rootTaskId??task.id)===rootTaskId&&task.resultVersion!==undefined&&['completed','needs-attention'].includes(task.status)).sort((a,b)=>(b.resultVersion??0)-(a.resultVersion??0)||b.createdAt-a.createdAt)[0];
  }
  private async withFamilyCommit<T>(rootTaskId:string,work:()=>Promise<T>):Promise<T>{
    const previous=this.familyCommits.get(rootTaskId)??Promise.resolve();let release!:()=>void;
    const current=new Promise<void>(resolve=>{release=resolve}),tail=previous.then(()=>current);this.familyCommits.set(rootTaskId,tail);
    await previous;try{return await work()}finally{release();if(this.familyCommits.get(rootTaskId)===tail)this.familyCommits.delete(rootTaskId)}
  }
  private family(id:string){const task=this.tasks.get(id);if(!task)throw new Error('任务不存在');const root=task.rootTaskId??task.id;return{root,tasks:[...this.tasks.values()].filter(item=>(item.rootTaskId??item.id)===root)}}
  private async stopFamily(id:string){const family=this.family(id);for(const task of family.tasks){if(!['queued','running'].includes(task.status))continue;task.attempt++;task.status='failed';task.error='任务已停止';task.completedAt=Date.now();this.queue=this.queue.filter(item=>item!==task.id);for(const step of task.steps)if(step.status==='running'){step.status='failed';step.completedAt=Date.now()}await Promise.allSettled((this.running.get(task.id)??[]).map(runtime=>runtime.stop()));await this.publish(task)}await Promise.all(family.tasks.map(task=>this.writes.get(task.id)??Promise.resolve()));return family}
  async archiveFamily(id:string){const initial=this.family(id);await this.withFamilyCommit(initial.root,async()=>{const family=await this.stopFamily(id),archivedAt=Date.now();for(const task of family.tasks){task.archivedAt=archivedAt;await this.publish(task)}})}
  async restoreFamily(id:string){const family=this.family(id);await this.withFamilyCommit(family.root,async()=>{for(const task of family.tasks){delete task.archivedAt;await this.publish(task)}})}
  async deleteFamily(id:string){const initial=this.family(id);await this.withFamilyCommit(initial.root,async()=>{const family=await this.stopFamily(id);this.deletedFamilies.add(family.root);await this.writeAtomic(path.join(this.root,`.deleted-${family.root}.json`),{rootTaskId:family.root,deletedAt:Date.now()});for(const task of family.tasks){this.queue=this.queue.filter(item=>item!==task.id);await rm(path.join(this.root,`${task.id}.json`),{force:true});await rm(path.join(this.root,task.id),{recursive:true,force:true})}const snapshots=[...new Set(family.tasks.map(task=>task.project.inputSnapshotPath).filter((value):value is string=>Boolean(value)))];for(const snapshot of snapshots){const referenced=[...this.tasks.values()].some(task=>!family.tasks.some(deleted=>deleted.id===task.id)&&task.project.inputSnapshotPath===snapshot),relative=path.relative(path.join(this.root,'input-snapshots'),snapshot);if(!referenced&&relative&&!relative.startsWith('..')&&!path.isAbsolute(relative))await rm(snapshot,{recursive:true,force:true})}for(const task of family.tasks)this.tasks.delete(task.id)})}
  async updateDeliveryScope(request:import('../src/types.js').DeliveryScopeUpdateRequest){
    const operationId=request.operationId?.trim()||randomUUID(),repeat=[...this.tasks.values()].find(task=>task.operationId===operationId);
    if(repeat)return structuredClone(repeat);
    if(!request.targets.length)throw new Error('请选择要更新的功能或需求');
    const base=this.tasks.get(request.baseTaskId);
    if(!base||base.archivedAt||base.resultVersion===undefined||!['completed','needs-attention'].includes(base.status))throw new Error('基础结果不存在、已归档或尚未形成结果');
    const root=base.rootTaskId??base.id;
    return this.withFamilyCommit(root,async()=>{
      const latest=this.latestResult(root);
      if(!latest||latest.id!==base.id||request.baseVersion!==base.resultVersion)throw new Error(`结果已更新到第 ${latest?.resultVersion??base.resultVersion} 版，请在最新版上操作`);
      const project=structuredClone(base.project),changed=new Set<string>();
      for(const target of request.targets){
        if(target.kind==='feature'){
          const feature=project.features.find(item=>item.id===target.id);if(!feature)throw new Error(`功能不存在：${target.id}`);
          feature.deliveryScope=request.scope;
          for(const requirement of project.requirements.filter(item=>feature.requirementIds.includes(item.id))){requirement.deliveryScope=request.scope;changed.add(requirement.id)}
        }else{
          const requirement=project.requirements.find(item=>item.id===target.id);if(!requirement)throw new Error(`需求不存在：${target.id}`);
          requirement.deliveryScope=request.scope;changed.add(requirement.id);
        }
      }
      const now=Date.now(),id=`T-${randomUUID().slice(0,8).toUpperCase()}`,resultVersion=base.resultVersion+1,proofVersion=(base.checkpoint?.resultVersion??0)+1;
      const checks=requiredChecks(project,proofVersion),previous=base.checkpoint?.checks;
      for(const check of Object.values(checks)){const old=previous?.[check.id];if(old)check.status=old.status;check.issueIds=old?.issueIds??[]}
      project.delivery=assessDelivery(project,checks,proofVersion);
      const task:AnalysisTask={...structuredClone(base),id,operationId,rootTaskId:root,parentTaskId:base.id,baseResultVersion:base.resultVersion,resultVersion,project,scopeChange:{operationId,scope:request.scope,targets:structuredClone(request.targets),changedRequirementIds:[...changed],changedAt:now},artifacts:[],createdAt:now,requestedAt:now,startedAt:now,completedAt:now,checkpoint:{...structuredClone(base.checkpoint),pipelineVersion:CURRENT_PIPELINE_VERSION,resultVersion:proofVersion,checks,verificationCompletedVersion:proofVersion,verificationDependencyHash:contentFingerprint(project),detailedFeatureIds:base.checkpoint?.detailedFeatureIds??[],auditIssues:base.checkpoint?.auditIssues??[],validationFailures:base.checkpoint?.validationFailures??[]}};
      delete task.archivedAt;this.tasks.set(id,task);await this.publish(task);return structuredClone(task);
    })
  }
  async recordArtifact(taskId:string,artifact:Omit<import('../src/types.js').TaskArtifact,'id'|'createdAt'>){const task=this.tasks.get(taskId);if(!task)throw new Error('任务不存在');const value={...artifact,id:`A-${randomUUID().slice(0,8).toUpperCase()}`,createdAt:Date.now()};task.artifacts=[...(task.artifacts??[]),value];await this.publish(task);return structuredClone(value)}
  async queryArtifacts(taskId:string){const task=this.tasks.get(taskId);if(!task)throw new Error('任务不存在');return Promise.all((task.artifacts??[]).slice().sort((a,b)=>b.createdAt-a.createdAt).map(async artifact=>{let exists=false;try{exists=(await stat(artifact.path)).isDirectory()}catch{}return{...structuredClone(artifact),exists}}))}
  private async discoverArtifacts(task:AnalysisTask){const artifacts:NonNullable<AnalysisTask['artifacts']>=[];for(const bucket of ['deliveries','drafts'] as const){const directory=path.join(this.root,task.id,'result',bucket);let entries:string[];try{entries=await readdir(directory)}catch{continue}for(const name of entries){const candidate=path.join(directory,name);let metadata;try{metadata=await stat(candidate);if(!metadata.isDirectory())continue}catch{continue}artifacts.push({id:`A-LEGACY-${createHash('sha256').update(candidate).digest('hex').slice(0,12)}`,kind:bucket==='deliveries'?'agent-package':'draft',path:candidate,resultVersion:task.resultVersion!,createdAt:metadata.mtimeMs})}}return artifacts.sort((a,b)=>b.createdAt-a.createdAt)}
  async cancel(id: string) {
    const task = this.tasks.get(id); if (!task || task.status === 'completed') return;
    task.attempt++; task.status = 'failed'; task.error = '用户已取消任务'; task.completedAt = Date.now();
    this.queue = this.queue.filter(x => x !== id);
    for (const step of task.steps) if (step.status === 'running') { step.status = 'failed'; step.completedAt = Date.now(); }
    await this.publish(task);
    await Promise.allSettled((this.running.get(id) ?? []).map(r => r.stop()));
  }
  async retry(id: string) {
    const task = this.tasks.get(id); if (!task || !['failed','needs-attention'].includes(task.status)) return;
    if (task.checkpoint?.pipelineVersion !== CURRENT_PIPELINE_VERSION) throw new Error('旧版检查点不可续跑，请使用任务保存的原始材料重新执行');
    const needsAttention=task.status==='needs-attention';
    task.attempt++; task.status = 'queued'; task.error = undefined; task.completedAt = undefined;
    if(needsAttention){for(const index of [5,6]){const step=task.steps[index];step.status='pending';step.startedAt=undefined;step.completedAt=undefined}}
    for (const step of task.steps) if (step.status === 'failed') { step.status = 'pending'; step.startedAt = undefined; }
    if (!this.queue.includes(id)) this.queue.push(id);
    await this.publish(task); void this.pump();
  }
  async restart(id: string) {
    const task = this.tasks.get(id);
    if (!task || task.archivedAt || !['failed', 'needs-attention'].includes(task.status)) throw new Error('当前任务不可重新开始');
    return this.create(structuredClone(task.project));
  }
  private assert(task: AnalysisTask, attempt: number) {
    if (task.attempt !== attempt || task.status !== 'running') throw new Error('当前执行尝试已取消或失效');
  }
  private drainSlots() { while (this.slots < this.slotLimit && this.slotQueue.length) { this.slots++; this.slotQueue.shift()!(); } }
  private acquire() { return new Promise<void>(resolve => { this.slotQueue.push(resolve); this.drainSlots(); }); }
  private release() { this.slots--; this.drainSlots(); }
  private async pump() {
    if (this.pumping) return; this.pumping = true;
    try {
      const current = await this.getConfig(), concurrency = schedulerConcurrency(current), limit = concurrency.taskLimit;
      this.slotLimit = concurrency.slotLimit; this.drainSlots();
      while (this.running.size < limit && this.queue.length) {
        const index = this.queue.findIndex(id => !this.running.has(id)); if (index < 0) break;
        const task = this.tasks.get(this.queue.splice(index, 1)[0]); if (!task || task.status !== 'queued') continue;
        const saved = task.runtimeConfig ?? snapshot(current), config = { ...saved, apiKey: saved.credentialRef && saved.adapter === current.adapter && saved.provider === current.provider ? current.apiKey : undefined }, runtimes: AnalysisRuntime[] = [];
        this.running.set(task.id, runtimes);
        void this.run(task, config, runtimes).finally(() => { this.running.delete(task.id); void this.pump(); });
      }
    } finally { this.pumping = false; }
  }

  private async run(task: AnalysisTask, config: RuntimeConfig, runtimes: AnalysisRuntime[]):Promise<void> {
    const attempt = task.attempt, workspace = path.join(this.root, task.id), session = `prd-${task.id}-a${attempt}`, pool = schedulerConcurrency(config).nodeLimit, cp = task.checkpoint!;
    task.status = 'running'; task.startedAt ??= Date.now(); task.completedAt = undefined; task.error = undefined;
    const cache = new Map<ModelNodeId, Promise<AnalysisRuntime>>(), busy = Array(stages.length).fill(0) as number[];
    const previousStatus = task.steps.map(s => s.status);
    let activeStage = 0;
    let localSlots=0;const localQueue:Array<()=>void>=[];
    const acquireLocal=async()=>{if(localSlots<pool){localSlots++;return}await new Promise<void>(resolve=>localQueue.push(resolve));localSlots++};
    const releaseLocal=()=>{localSlots--;localQueue.shift()?.()};
    const checkpoint = async () => { this.assert(task, attempt); await this.publish(task); this.assert(task, attempt); };
    const runtimeFor = (node: ModelNodeId) => {
      let runtime = cache.get(node);
      if (!runtime) { const effective = nodeConfig(config, node); runtime = (async () => { ensureStructuredCapability(effective);const r = this.runtimeFactory(effective); runtimes.push(r); await r.start(path.join(workspace, `runtime-${node}`), effective); return r; })(); cache.set(node, runtime); }
      return runtime;
    };
    const call = async <T>({contract,node,purpose,title,instruction,input,accept,images=[],preparedEvidence=false,materialize=materializeEvidenceSelections}:NodeCall<T>): Promise<T> => {
      const organization=(task.project.analysisInputApplications??[]).filter(item=>item.kind==='organization').map(item=>item.summary);
      if(organization.length)instruction+='\n用户组织参数（不是业务事实，不得据此新增规则）：'+JSON.stringify(organization);
      const queuedAt=Date.now();this.assert(task, attempt);await acquireLocal();let global=false;
      try{await this.acquire();global=true}catch(error){releaseLocal();throw error}
      const index = nodeStep[node], step = task.steps[index]; let entered = false;
      try {
        this.assert(task, attempt); entered = true;
        if (busy[index]++ === 0) { previousStatus[index] = step.status; step.startedAt = Date.now(); step.status = 'running'; }
        step.runs = (step.runs ?? 0) + 1;
        const sequence = cp.modelCallSequence = (cp.modelCallSequence ?? 0) + 1;
        await checkpoint();
        const evidence = preparedEvidence?{input,catalog:[]} : evidencePromptInput(input),built=prompt(title,instruction,evidence.input),budgetClass=budgetClassFor(node,purpose);
        const sessionId=`${session}-${purpose}-${sequence}`;
        let result:T;
        try { result = await executeNode({...nodeContracts[contract],id:contract,version:1,parameters:schemaToJson(nodeContracts[contract].proposal),instructions:`${built.sections.preamble}\n${instruction}`,accept:value=>acceptCandidate(()=>accept(preparedEvidence?value:materialize(value,evidence.catalog)))},{workItemId:purpose,executionId:`${task.id}-a${attempt}`,input:evidence.input,runtime:()=>runtimeFor(node),configuration:snapshot(nodeConfig(config,node)),receipts:cp.nodeReceipts??={},save:checkpoint,assert:()=>this.assert(task,attempt),images,timeoutMs:attemptTimeoutMs(),onAttempt:async(validationAttempt,current,operationId)=>{const startedAt=Date.now(),measurement=measurePrompt(current,budgetClass,validationAttempt===1?built.sections:{request:current});(cp.promptMetrics??=[]).push({sessionId:operationId,attempt:validationAttempt,node,purpose,queuedAt,startedAt,queueMs:validationAttempt===1?startedAt-queuedAt:0,requestHash:createHash('sha256').update(current).digest('hex'),...measurement});await checkpoint()},onInvalid:async (validationAttempt,response,issues)=>{
          const message=issues.map(issue=>`${issue.path}: ${issue.expected}；${issue.actual}`).join('\n');
          const directory=path.join(workspace,'diagnostics');await mkdir(directory,{recursive:true});const responsePath=path.join(directory,`${sessionId}-try${validationAttempt}.json`);
          await writeFile(responsePath,JSON.stringify({sessionId,node,purpose,message,issues,response,requestHash:createHash('sha256').update(JSON.stringify(evidence.input)).digest('hex'),at:Date.now()},null,2),'utf8');
          (cp.validationFailures??=[]).push({sessionId,node,purpose,message,issues,responsePath,at:Date.now()});await checkpoint();
        }}); } catch(error) { if(error instanceof NodeExecutionError&&error.category==='validation'){const wrapped=new ModelOutputValidationError(error.message,error);wrapped.stepIndex=index;wrapped.purpose=purpose;wrapped.title=title;throw wrapped}throw error }
        this.assert(task, attempt); return result;
      } finally {
        if (entered && --busy[index] === 0 && task.attempt === attempt) {
          step.durationMs = (step.durationMs ?? 0) + Date.now() - (step.startedAt ?? Date.now());
          step.completedAt = Date.now(); step.startedAt = undefined;
          if (step.status === 'running') step.status = previousStatus[index] === 'completed' ? 'completed' : 'pending';
        }
        if(global)this.release();releaseLocal();
      }
    };
    const stage = async (index: number, work: () => Promise<void>) => {
      this.assert(task, attempt); activeStage = index;
      const step = task.steps[index]; if (step.status === 'completed') return;
      const began = Date.now(), before = step.durationMs ?? 0;
      step.status = 'running'; step.startedAt = began; await checkpoint();
      await work(); this.assert(task, attempt);
      step.status = 'completed'; step.completedAt = Date.now(); step.startedAt = undefined;
      if ((step.durationMs ?? 0) === before) step.durationMs = before + Date.now() - began;
      task.progress = Math.max(task.progress, (index + 1) * (100/stages.length)); await checkpoint();
    };
    let sourceReader: SourceIndex | undefined;
    const sourceUnits = (ids: Iterable<string>) => { const requested=Array.from(new Set(ids));const index=sourceReader??=new SourceIndex(task.project.sourceUnits,task.project.revision);const result:SourceUnit[]=[];for(let i=0;i<requested.length;i+=100)result.push(...index.read(requested.slice(i,i+100)));return result; };
    const identify = (units: SourceUnit[], purpose: string, currentCandidates?: Feature[], issues?: unknown) => {
      const aliases=new Map(units.map((unit,index)=>[unit.id,`S${index+1}`])),sourceIds=new Map([...aliases].map(([id,alias])=>[alias,id])),mapValue=(value:unknown,restore=false):unknown=>Array.isArray(value)?value.map(item=>mapValue(item,restore)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,item])=>[key,mapValue(item,restore)])):typeof value==='string'?(restore?(sourceIds.get(value)??value):(aliases.get(value)??value)):value,replaceContext=(value:string|undefined)=>{if(!value)return value;let result=value;for(const [id,alias] of aliases)result=result.split(id).join(alias);return result};
      const promptUnits=units.map(unit=>({...unit,id:aliases.get(unit.id)!,context:replaceContext(unit.context)}));
      const inputApplications=(task.project.analysisInputApplications??[]).filter(item=>units.some(unit=>unit.id===item.sourceUnitId));
      return call({contract:'candidates',node:currentCandidates ? 'featureCandidateRepair' : 'featureCandidates',purpose:purpose,title:currentCandidates ? '功能候选识别·定点返工' : '功能候选识别',instruction:`${sourceClassificationContract}识别实际业务功能及真正跨功能约束。同一功能的必填、枚举、默认值等属性归入该功能，不另造跨功能约束。文档记法、表头及原文中未形成明确要求的问题作为上下文，不生成待处理事项或伪功能；标题中的新增模块、重命名等明确业务要求仍需关联实际功能。userInputApplications 中 organization 只控制整理方式，question 不转化为需求，scope-decision 必须关联真实功能以便平台确定性应用范围，不得改写为肯定业务规则。每来源恰好一条处置；存在明确要求时不能整段仅分类为背景。返工同时纠正候选与来源分类，保留无关候选。输出 ${candidateSchema}`,input:{ sourceUnits: promptUnits, userInputApplications:mapValue(inputApplications), currentCandidates:mapValue(currentCandidates), coverageIssues:mapValue(issues) },accept:raw => {const v=mapValue(raw,true) as Record<string,unknown>;return acceptDirectFeatureBatch(v.features,v.sourceDispositions,units)}});
    };
    const unify = async (candidates: Feature[], units: SourceUnit[], dispositions: SourceDisposition[], issues?: AuditIssue[], depth=0, mergeOnly=false): Promise<Feature[]> => {
      const businessSourceIds=new Set(dispositions.filter(item=>item.kind==='requirement').map(item=>item.sourceUnitId));
      const effectiveCandidates=candidates.map(candidate=>{const sourceRefs=(candidate.sourceRefs??candidate.sourceUnitIds.map(sourceUnitId=>({sourceUnitId}))).filter(ref=>businessSourceIds.has(ref.sourceUnitId)),sourceUnitIds=[...new Set(sourceRefs.map(ref=>ref.sourceUnitId))];return sourceRefs.length?{...candidate,sourceRefs,sourceUnitIds}:candidate});
      if (!issues && effectiveCandidates.length < 2) return Promise.resolve(acceptFeatureUnification({ features: effectiveCandidates, candidateMappings: effectiveCandidates.map(f => ({ candidateId: f.id, featureIds: [f.id] })) }, effectiveCandidates, units));
      if(effectiveCandidates.length>10&&depth===0){
        const groups=[...effectiveCandidates.reduce((all,item)=>{const key=item.id.match(/^C-\d+/)?.[0]??item.id.match(/^H\d+-\d+/)?.[0]??item.id;const group=all.get(key)??[];group.push(item);all.set(key,group);return all},new Map<string,Feature[]>()).values()],chunks:Feature[][]=[];
        for(const group of groups){const current=chunks.at(-1);if(!current||current.length+group.length>8)chunks.push([...group]);else current.push(...group)}
        const partials=await mapPool(chunks,pool,async(chunk,index)=>{const ids=new Set(chunk.flatMap(item=>item.sourceUnitIds)),chunkIssues=issues?.filter(issue=>issue.sourceUnitIds.some(id=>ids.has(id))),merged=await unify(chunk,units.filter(unit=>ids.has(unit.id)),dispositions.filter(item=>ids.has(item.sourceUnitId)),chunkIssues?.length?chunkIssues:undefined,depth+1),remap=new Map(merged.map((item,itemIndex)=>[item.id,`H${depth+1}-${index+1}-${itemIndex+1}`]));return merged.map(item=>({...item,id:remap.get(item.id)!,appliesToFeatureIds:item.appliesToFeatureIds?.map(id=>remap.get(id)??id)}))});
        const flattened=partials.flat();
        return unify(flattened,units,dispositions,undefined,depth+1,true);
      }
      const sourceAliases=new Map(units.map((unit,index)=>[unit.id,`U${index+1}`])),sourceIds=new Map([...sourceAliases].map(([id,alias])=>[alias,id]));
      const restoreSourceIds=(value:unknown):unknown=>Array.isArray(value)?value.map(restoreSourceIds):value&&typeof value==='object'?Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,item])=>[key,restoreSourceIds(item)])):typeof value==='string'&&sourceIds.has(value)?sourceIds.get(value):value;
      const aliasSourceIds=(value:unknown):unknown=>Array.isArray(value)?value.map(aliasSourceIds):value&&typeof value==='object'?Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,item])=>[key,aliasSourceIds(item)])):typeof value==='string'&&sourceAliases.has(value)?sourceAliases.get(value):value;
      const candidateProjection=effectiveCandidates.map(({id,name,kind,appliesToFeatureIds,sourceUnitIds,state})=>({id,name,kind,appliesToFeatureIds,sourceUnitIds:sourceUnitIds.map(sourceUnitId=>sourceAliases.get(sourceUnitId)??sourceUnitId),state}));
      const dispositionProjection=dispositions.filter(d=>units.some(u=>u.id===d.sourceUnitId)).map(({sourceUnitId,kind,featureIds})=>({sourceUnitId:sourceAliases.get(sourceUnitId)??sourceUnitId,kind,featureIds}));
      const resolve = (evidence?: SourceUnit[]) => call({contract:'unify',node:'featureGlobal',purpose:'unify',title:issues ? '功能清单统一·定点返工' : '功能清单统一',instruction:`${sourceClassificationContract}sourceDispositions是当前来源分类账本；候选只保留 requirement 来源的精确选区，context 标题不参与拆分证据分配。候选关联context来源不表示把它当产品要求。name 只生成简短、可区分的导航名称，不得补充业务规则、范围或目标摘要。按完整业务能力统一候选边界，必须处理跨包语义重叠：同一对象的字段属性、历史迁移、联动和附录枚举应组织到对应完整功能；概览候选映射到相关实际功能，不再保留一份宽泛重复功能。仅真正跨功能的独立约束单列。不得以保留候选ID为由原样照抄全部候选；也不得为减少数量合并无关业务。${mergeOnly?'这是分片结果的全局合并层：每个输入候选只能映射到一个输出功能，禁止再次拆分或请求原文。':''}若发现候选把文档记法/表头/结构保存当产品功能或来源分类错误，先返回 {"classificationIssues":[{"candidateIds":["输入候选ID"],"sourceUnitIds":["来源ID"],"detail":"分类错误与业务依据"}]}，由控制器退回识别和独立检查；你不直接删除或改分类。每候选恰好一个映射记录，${mergeOnly?'且只能映射一个输出功能':'可以映射多个输出功能'}；每个输出均有候选依据。每候选来源必须在其目标功能并集中保留，禁止猜测或补入其他候选的来源。优先保留现有功能 ID，新增用 LOCAL ID。输出紧凑结构 {"features":[${unifiedFeatureSchema}],"candidateMappings":[{"candidateId":"输入候选ID","featureIds":["输出功能ID"]}]}。features禁止重复抄写来源。一个候选映射单个目标时，其全部精确选区由脚本自动并入该目标。${mergeOnly?'':'映射多个目标时，必须先请求相关原文，并且每个候选只能选择 evidenceCatalog 中 candidateIds 包含该候选 ID 的证据，再在该 mapping 增加 allocations:[{"featureId":"目标ID","evidenceIds":["从 evidenceCatalog 选择的证据ID"]}]；每个目标非空，候选选区覆盖完整且不得越界。尚未看到待拆分候选全部原文时返回 {"neededSourceUnitIds":["有争议的来源ID"]}，不得凭来源ID猜测。'}`,input:{ candidates:candidateProjection, sourceUnits: evidence?.map(unit=>({...unit,id:sourceAliases.get(unit.id)??unit.id})), evidenceSourceRefs:evidence?effectiveCandidates.flatMap(item=>(item.sourceRefs??[]).map(ref=>({...ref,sourceUnitId:sourceAliases.get(ref.sourceUnitId)??ref.sourceUnitId}))):undefined, candidateEvidenceRefs:evidence?effectiveCandidates.map(item=>({candidateId:item.id,refs:(item.sourceRefs??[]).map(ref=>({...ref,sourceUnitId:sourceAliases.get(ref.sourceUnitId)??ref.sourceUnitId}))})):undefined, sourceDispositions: dispositionProjection, issues:aliasSourceIds(issues) },accept:raw => {const v=restoreSourceIds(raw) as Record<string,unknown>;
        if (Array.isArray(v.classificationIssues) && v.classificationIssues.length) return { classificationIssues: acceptCandidateClassificationIssues(v.classificationIssues, effectiveCandidates, units) };
        if (mergeOnly&&Array.isArray(v.neededSourceUnitIds)) throw new DomainValidationError('全局合并层不得重新请求原文');
        if (Array.isArray(v.neededSourceUnitIds)) {
          const requested = v.neededSourceUnitIds;
          if (!requested.length || requested.some(id => typeof id !== 'string' || !units.some(u => u.id === id))) throw new DomainValidationError('原文请求包含无效来源');
          if(evidence&&requested.every(id=>evidence.some(unit=>unit.id===id)))throw new DomainValidationError('所请求原文已完整提供，必须返回功能映射，不得重复请求同一来源');
          return { needed: requested as string[] };
        }
        // 拆分决定必须看到来源内容；单目标合并可由显式映射确定性编译。
        if (mergeOnly&&Array.isArray(v.candidateMappings)&&v.candidateMappings.some(mapping=>Array.isArray(mapping?.featureIds)&&mapping.featureIds.length!==1)) throw new DomainValidationError('全局合并层每个候选必须且只能映射一个输出功能');
        if (Array.isArray(v.candidateMappings)) {
          const splitIds = new Set(v.candidateMappings.filter(m => Array.isArray(m?.featureIds) && m.featureIds.length > 1).map(m => m.candidateId));
          const required = effectiveCandidates.filter(c => splitIds.has(c.id)).flatMap(c => c.sourceUnitIds);
          if (required.some(id => !evidence?.some(u => u.id === id))) return { needed: [...new Set([...(evidence ?? []).map(u => u.id), ...required])] };
        }
        return { features: acceptFeatureUnification(v, effectiveCandidates, units) };
      }});
      const issueSourceIds=issues?new Set(issues.flatMap(issue=>issue.sourceUnitIds)):undefined;
      const requestedSourceIds=new Set(issueSourceIds??[]);
      let resolved = await resolve(requestedSourceIds.size ? units.filter(unit=>requestedSourceIds.has(unit.id)) : undefined);
      for(let expansion=0;resolved.needed&&expansion<8;expansion++){
        const before=requestedSourceIds.size;for(const id of resolved.needed)requestedSourceIds.add(id);
        if(requestedSourceIds.size===before)break;
        resolved=await resolve(units.filter(unit=>requestedSourceIds.has(unit.id)));
      }
      if (resolved.classificationIssues) throw new CandidateClassificationError(resolved.classificationIssues);
      if (!resolved.features) throw new Error('补充原文后仍未返回功能映射');
      return resolved.features;
    };
    const graph = () => validateDirectGraph(task.project.sourceUnits, task.project.sourceDispositions ?? [], task.project.features, task.project.requirements, task.project.clarifications);
    if(cp.auditIssues?.length)routeUnownedSourceIssues(task.project,cp.auditIssues);
    try {
      await mkdir(workspace, { recursive: true }); await checkpoint();
      if(task.adjustment&&task.parentTaskId&&task.resultVersion===undefined){
        const base=this.tasks.get(task.parentTaskId);if(!base)throw new Error('基础结果不存在，无法继续调整');
        const adjustmentStep=task.steps[3];adjustmentStep.status='running';adjustmentStep.startedAt=Date.now();adjustmentStep.runs=(adjustmentStep.runs??0)+1;await checkpoint();
        if(!task.adjustment.feedback)throw new Error('旧版逐项调整任务只能查看，不能按新版流程续跑');
        const request={feedback:task.adjustment.feedback,references:task.adjustment.references,baseTaskId:base.id,baseVersion:task.baseResultVersion??base.resultVersion??1,};
        const engine=new RefinementAdjustmentEngine({generate:async input=>{const nodes={adjustmentParse:'inputInterpretation',adjustmentGenerate:'details',adjustmentRepair:'repair',adjustmentReview:'audit'} as const;return call({contract:input.operation,node:nodes[input.operation],purpose:input.operation,title:input.title,instruction:input.instruction,input:input.input,accept:input.accept,preparedEvidence:true})}});
        const run=await engine.run({taskId:base.id,version:base.resultVersion??1,project:base.project,userEvidence:task.project.userEvidence},request);
        task.project=structuredClone(run.project);task.adjustment.plan=run.plan;task.adjustment.results=run.results;
        for(const feature of task.project.features)if(feature.deliveryScope==='excluded')for(const requirement of task.project.requirements.filter(item=>feature.requirementIds.includes(item.id)&&item.deliveryScope===undefined))requirement.deliveryScope='excluded';
        adjustmentStep.completedAt=Date.now();adjustmentStep.startedAt=undefined;
        if(run.status==='failed'){adjustmentStep.status='failed';throw new Error(run.error??'调整生成失败')}
        adjustmentStep.status='completed';
        for(const [index,note] of [[4,'调整引擎已逐项核查变更依据'],[5,'未通过项已在调整引擎内定点修正并复核']] as const){const step=task.steps[index];step.status='completed';step.note=note;step.startedAt=adjustmentStep.startedAt;step.completedAt=adjustmentStep.completedAt;}
        task.progress=(6/stages.length)*100;await checkpoint();
        validateDirectGraph(task.project.sourceUnits,task.project.sourceDispositions??[],task.project.features,task.project.requirements,task.project.clarifications);
          if(task.project.relations?.length)task.project.relations=acceptRequirementRelations(task.project.relations,task.project.sourceUnits,task.project.requirements);
          delete task.project.delivery;
          const proofVersion=(cp.resultVersion??0)+1;cp.resultVersion=proofVersion;
          const platformIssues=(task.project.audit?.issues??[]).filter(issue=>issue.disposition==='open');
          task.project.audit={passed:platformIssues.length===0,issues:task.project.audit?.issues??[]};task.audit=task.project.audit;
          const ledger=requiredChecks(task.project,proofVersion),baseChecks=base.checkpoint?.checks;for(const check of Object.values(ledger)){check.status=check.id==='source'?'passed':baseChecks?.[check.id]?.status??'unknown';check.issueIds=platformIssues.filter(issue=>check.id==='relation'?issue.owner==='requirement-relation':check.id==='detail'?issue.owner==='requirement-detail'||issue.owner==='runtime-output':check.id==='feature'?issue.owner==='feature-grouping':false).map(issue=>issue.id)}cp.checks=ledger;
          task.project.delivery=assessDelivery(task.project,cp.checks,proofVersion);
          const deliveryStep=task.steps[6];deliveryStep.status='running';deliveryStep.startedAt=Date.now();await checkpoint();
          await this.withFamilyCommit(task.rootTaskId??base.id,async()=>{
            this.assert(task,attempt);const latest=this.latestResult(task.rootTaskId??base.id),baseVersion=task.baseResultVersion??1;
            if(!latest||latest.id!==base.id||latest.resultVersion!==baseVersion)throw new Error(`基础结果已更新：当前为第 ${latest?.resultVersion??baseVersion} 版；本次输入和候选已保留，请在最新版上重新提交`);
            const result=path.join(workspace,'result'),packageRoot=path.join(result,task.project.delivery?.state==='ready'?'deliveries':'drafts');await mkdir(result,{recursive:true});
            const intendedVersion=baseVersion+1,written=await writeAgentPackage(task.project,{...task,resultVersion:intendedVersion},packageRoot);await this.writeAtomic(path.join(this.root,`${task.project.id}.project.json`),task.project);
            task.resultVersion=intendedVersion;task.artifacts=[...(task.artifacts??[]),{id:`A-${randomUUID().slice(0,8).toUpperCase()}`,kind:task.project.delivery?.state==='ready'?'agent-package':'draft',path:written.directory,resultVersion:intendedVersion,createdAt:Date.now()}];deliveryStep.status='completed';deliveryStep.completedAt=Date.now();deliveryStep.startedAt=undefined;
            const feedbackFailed=task.adjustment?.results?.some(item=>item.status==='failed')??false;task.status=feedbackFailed?'failed':'completed';task.progress=100;task.error=feedbackFailed?'部分调整无法定位或应用，清单保持已核查结果':undefined;task.completedAt=Date.now();await this.publish(task);
          });
        return;
      }
      await stage(0, async () => {
        if(!task.project.sourceDocuments){const synthetic=task.project.sourceUnits.filter(unit=>unit.synthetic),base=task.project.sourceUnits.filter(unit=>!unit.synthetic);task.project.sourceUnits=[...enrichSourceContext(base.length?base:buildSourceUnits(task.project.rawText)),...synthetic]}
        await mapPool(task.project.sourceUnits.filter(u => u.asset && u.asset.readStatus !== 'read'), pool, async unit => {
          const asset = unit.asset!; if (asset.readStatus === 'blocked') throw new Error(`图片无法读取：${unit.location}：${asset.error ?? '格式不支持'}`);
          if (createHash('sha256').update(await readFile(asset.path)).digest('hex') !== asset.sha256) throw new Error(`图片资产哈希不匹配：${unit.id}`);
          const result = await call({contract:'image',node:'imageReading',purpose:`asset-${unit.id}`,title:'图片内容读取',instruction:'逐项转录需求文字、表格、关系及图注，看不清则readable=false。输出 {"readable":true,"text":"..."}。',input:{ location: unit.location },accept:v => {
            if (typeof v.readable !== 'boolean' || typeof v.text !== 'string' || !v.text.trim()) throw new DomainValidationError('图片读取结构错误'); return { readable: v.readable, text: v.text };
          },images:[{ path: asset.path, mimeType: asset.mimeType }]});
          asset.extractedText = result.text; asset.readStatus = result.readable ? 'read' : 'blocked'; unit.status = result.readable ? 'processed' : 'blocked'; await checkpoint();
          if (!result.readable) throw new Error(`图片内容未完整读取：${unit.location}`);
        });
        if (task.project.sourceDocuments) {
          for(const document of task.project.sourceDocuments)if(!sourceCoverage(document.rawText,task.project.sourceUnits.filter(u=>u.fileId===document.fileId)).complete)throw new Error(`原文建账字符覆盖不完整：${document.logicalPath}`);
        } else if (!sourceCoverage(task.project.rawText, task.project.sourceUnits.filter(unit=>!unit.synthetic)).complete) throw new Error('原文建账字符覆盖不完整');
        const unread = task.project.sourceUnits.filter(u => u.status !== 'processed');
        if (unread.length) throw new Error(`存在 ${unread.length} 个未读取的原文单元：${unread.slice(0,8).map(u=>`${u.id} ${u.label}`).join('；')}${unread.length>8?'；更多项见来源记录':''}`);
        const userUnits=attachInitialUserInput(task.project);
        if(userUnits.length&&!task.project.analysisInputApplications?.length){
          task.project.analysisInputApplications=await call({contract:'inputInterpretation',node:'inputInterpretation',purpose:'input-interpretation',title:'理解本次补充说明',instruction:'逐项判断用户原话的作用。business-fact 是新增或明确业务事实；scope-decision 是明确本期做或不做，并用 deliveryScope=current|excluded 表示；organization 只要求调整颗粒度、命名或呈现；question 是用户提出且仍待回答的问题；replacement 是明确替换既有口径。不得把疑问或整理要求改写成业务事实。每个输入 sourceUnitId 必须恰好返回一次。输出 {"entries":[{"sourceUnitId":"USER-...","kind":"business-fact|scope-decision|organization|question|replacement","summary":"说明平台将如何处理","deliveryScope":"仅 scope-decision 填 current|excluded"}]}。',input:{sourceUnits:userUnits.map(({id,excerpt})=>({id,excerpt}))},accept:value=>acceptInputApplications(value.entries,userUnits),preparedEvidence:true});
        }
      });
      // 两个职责独立、按候选内容流水并行；全部候选内容通过后才进入统一。
      const fixedSourceDispositions:SourceDisposition[]=[...task.project.sourceUnits.filter(unit=>!unit.synthetic&&(!unit.sourceRole||unit.sourceRole==='primary')&&unit.kind==='attachment'&&/HTML (?:样式|交互脚本)源码（来源数据，未执行；不是普通业务需求）/u.test(unit.context??'')).map(unit=>({sourceUnitId:unit.id,kind:'context' as const,reason:'解析器已识别为 HTML 样式或交互脚本源码；可见业务文字已由独立 DOM 来源单元登记',featureIds:[]})) ,...task.project.sourceUnits.filter(unit=>unit.synthetic||(unit.sourceRole&&unit.sourceRole!=='primary')).map(unit=>({sourceUnitId:unit.id,kind:'out-of-scope' as const,reason:'非主 PRD 资料仅供相关背景阅读，不作为正式需求来源',featureIds:[]}))];
      const fixedSourceIds=new Set(fixedSourceDispositions.map(item=>item.sourceUnitId));
      const packs = batches(task.project.sourceUnits.filter(unit=>!fixedSourceIds.has(unit.id)&&!unit.synthetic&&(!unit.sourceRole||unit.sourceRole==='primary')));
      const collectCandidates = async () => {
      if (task.steps[1].status !== 'completed') {
        await stage(1,async()=>{await mapPool(packs.map((units, index) => ({ units, index })).filter(x => !cp.featureCandidateBatches?.[x.index]), pool, async ({ units, index }) => {
          const persistCandidate = async (result: Awaited<ReturnType<typeof identify>>, clearFeedback = false) => {
            this.assert(task, attempt);
            const remap = new Map(result.features.map((f, n) => [f.id, `C-${index + 1}-${n + 1}`]));
            (cp.featureCandidateBatches ??= [])[index] = result.features.map(f => ({ ...f, id: remap.get(f.id)!, appliesToFeatureIds: f.appliesToFeatureIds?.map(id => remap.get(id)!) }));
            (cp.sourceDispositionBatches ??= [])[index] = result.dispositions.map(d => ({ ...d, featureIds: d.featureIds.map(id => remap.get(id)!) }));
            task.project.sourceDispositions = [...fixedSourceDispositions,...cp.sourceDispositionBatches.flat()];
            cp.featureCandidateBatchCount = cp.featureCandidateBatches.filter(Boolean).length;
            if (clearFeedback) delete cp.unificationFeedback![index];
            task.steps[1].note = `已识别 ${cp.featureCandidateBatchCount}/${packs.length} 份候选内容`; await checkpoint();
          };
          const feedback = cp.unificationFeedback?.[index];
          if (feedback?.length) {
            if ((cp.candidateRepairRounds?.[index] ?? 0) >= 2) throw new Error(`第 ${index + 1} 份候选内容已达到两轮返工上限：${feedback.map(i => i.detail).join('；')}`);
            const revised = await identify(units, `candidate-classification-${index}`, cp.featureCandidateBatches?.[index], feedback);
            (cp.candidateRepairRounds ??= [])[index] = (cp.candidateRepairRounds?.[index] ?? 0) + 1;
            await persistCandidate(revised, true);
           }
           if (!cp.featureCandidateBatches?.[index]) await persistCandidate(await identify(units, `candidate-${index}`));
        });});
      }
      };
      while (true) {
      await collectCandidates();
      try {
      await stage(2, async () => {
        const candidates = cp.featureCandidateBatches?.flat() ?? [], semantic = await unify(candidates, task.project.sourceUnits, [...fixedSourceDispositions,...cp.sourceDispositionBatches?.flat() ?? []]);
        const remap = new Map(semantic.map((f, i) => [f.id, `F-${String(i + 1).padStart(3, '0')}`]));
        task.project.features = semantic.map(f => ({ ...f, id: remap.get(f.id)!, appliesToFeatureIds: f.appliesToFeatureIds?.map(id => remap.get(id)!), requirementIds: [] }));
        task.project.sourceDispositions = [...fixedSourceDispositions,...cp.sourceDispositionBatches?.flat() ?? []].map(d => ({ ...d, featureIds: task.project.features.filter(f => f.sourceUnitIds.includes(d.sourceUnitId)).map(f => f.id) }));
        for(const application of task.project.analysisInputApplications??[]){
          application.affectedFeatureIds=task.project.features.filter(feature=>feature.sourceUnitIds.includes(application.sourceUnitId)).map(feature=>feature.id);
          if(application.kind==='scope-decision')for(const feature of task.project.features.filter(item=>application.affectedFeatureIds.includes(item.id)))feature.deliveryScope=application.deliveryScope;
        }
      });
      break;
      } catch (error) {
        if (!(error instanceof CandidateClassificationError)) throw error;
        if ((cp.unificationFeedbackRounds ?? 0) >= 2) throw new Error(`候选重分类已达到两轮反馈上限：${error.issues.map(i => i.detail).join('；')}`);
        cp.unificationFeedbackRounds = (cp.unificationFeedbackRounds ?? 0) + 1;
        for (let index = 0; index < packs.length; index++) {
          const ids = new Set(packs[index].map(u => u.id));
          const feedback = error.issues.filter(i => i.sourceUnitIds.some(id => ids.has(id))).map(i => ({ sourceUnitIds: i.sourceUnitIds.filter(id => ids.has(id)), detail: i.detail }));
          if (!feedback.length) continue;
          (cp.unificationFeedback ??= [])[index] = feedback;
          delete cp.featureCandidateBatches![index];
          delete cp.sourceDispositionBatches![index];
        }
        cp.featureCandidateBatchCount = cp.featureCandidateBatches!.filter(Boolean).length;
        for (const index of [1, 2]) task.steps[index].status = 'pending';
        task.progress = 100/stages.length; await checkpoint();
      }
      }
      await stage(3, async()=>{
        const results=cp.detailResults??={};
        await mapPool(task.project.features.filter(feature=>!results[feature.id]),pool,async feature=>{
          const applicableConstraints=task.project.features.filter(item=>item.kind==='constraint'&&item.appliesToFeatureIds?.includes(feature.id));
          const units=sourceUnits([...feature.sourceUnitIds,...applicableConstraints.flatMap(item=>item.sourceUnitIds)]),instruction=`忠实细化当前功能及适用约束，只整理原文明示内容。一个条目表达完整业务要求；同对象字段属性可合并，能分别漏做的行为才拆分。不得输出功能概述，不得补充常识、实现方案或测试。原文未明确的规则不补写；不生成待处理事项、建议、阻塞分析或澄清。每个需求项仅给简短 text 与条目级 evidenceIds，保留否定、条件和重要范围限定，字段细节通过原文阅读。输出 ${detailSchema}`;
          const featureInput={id:feature.id,name:feature.name,kind:feature.kind},constraintInputs=applicableConstraints.map(item=>({id:item.id,name:item.name,kind:item.kind}));
           const partials=await mapPool(batches(units,12),pool,async(batch,batchIndex)=>call({contract:'details',node:detailIsComplex(feature,units)?'details':'detailsFast',purpose:`details-${feature.id}-batch${batchIndex}`,title:'逐功能细化',instruction:instruction,input:{feature:featureInput,applicableConstraints:constraintInputs,sourceUnits:batch},accept:value=>acceptDirectDetails(value.requirements,value.clarifications,batch,true),images:[],preparedEvidence:false,materialize:(value,catalog)=>materializeDetailEvidenceSelections(value,catalog,feature.id)}));
          results[feature.id]=combineDetailBatches(partials);cp.detailedFeatureIds=Object.keys(results);task.steps[3].note=`已细化 ${cp.detailedFeatureIds.length}/${task.project.features.length} 个功能`;await checkpoint();
        });
        const materialized=new Set(cp.materializedFeatureIds??[]);this.assert(task,attempt);
         for(const feature of task.project.features.filter(item=>!materialized.has(item.id))){const result=results[feature.id],remap=new Map<string,string>();feature.requirementIds=[];for(const requirement of result.requirements){const id=nextId('R-',task.project.requirements,4);remap.set(requirement.id,id);task.project.requirements.push({...requirement,id,deliveryScope:feature.deliveryScope??requirement.deliveryScope});feature.requirementIds.push(id)}materialized.add(feature.id)}
         for(const application of task.project.analysisInputApplications??[])application.affectedRequirementIds=task.project.features.filter(feature=>application.affectedFeatureIds.includes(feature.id)).flatMap(feature=>feature.requirementIds);
        cp.materializedFeatureIds=[...materialized];await checkpoint();
      });
      // 有界功能边界返工：只重建发生变化的功能，保留其他需求编号和检查点。
        await stage(4, async()=>{
          const results=cp.auditIssueBatches??=[];
          const relationResults=cp.relationBatches??=[];
          const workStates=cp.auditWorkStates??={};
          const failures:Array<{featureId:string;message:string}>=[];
          await mapPool(task.project.features.map((feature,index)=>({feature,index})),pool,async({feature,index})=>{
            const scope=featureAuditScope(task.project,feature),requirements=scope.requirements;
            const evidence=sourceUnits(scope.sourceUnitIds);
            const inputHash=createHash('sha256').update(JSON.stringify({feature:{id:feature.id,name:feature.name,kind:feature.kind},requirements,evidence,requirementCatalog:task.project.requirements.map(({id,text})=>({id,text}))})).digest('hex');
            const previous=workStates[feature.id];if(previous?.state==='succeeded'&&previous.inputHash===inputHash&&results[index]&&relationResults[index])return;
            workStates[feature.id]={state:'running',inputHash,attempts:(previous?.inputHash===inputHash?previous.attempts:0)+1,updatedAt:Date.now()};await checkpoint();
            try{
              const checked=await call({contract:'audit',node:'audit',purpose:`evidence-audit-${feature.id}`,title:'产物依据核查',instruction:`只核查已有 requirements 是否受到所附原文支持：检查无依据新增、曲解原文以及丢失必要否定或范围限定。只检查已有需求与其引用原文的一致性，不要求增加条数或细化颗粒度，不分析原文未说明的业务问题，不生成澄清、阻塞判断或建议。仅当 evidence 明示两个已有需求的关系时返回 relations；requirementCatalog 只用于定位目标，不作为新需求依据。输出 ${auditSchema}`,input:{sourceUnits:evidence,feature:{id:feature.id,name:feature.name,kind:feature.kind},requirements,requirementCatalog:task.project.requirements.map(({id,text})=>({id,text}))},accept:v=>({issues:acceptDirectAuditIssues(v.issues,evidence,[feature],requirements,[],task.project.relations??[]),relations:acceptRequirementRelations(v.relations??[],evidence,task.project.requirements)})});
              results[index]=checked.issues;relationResults[index]=checked.relations;
              workStates[feature.id]={...workStates[feature.id],state:'succeeded',updatedAt:Date.now()};
              cp.executionFailures=(cp.executionFailures??[]).filter(item=>!(item.node==='audit'&&item.subjectId===feature.id));
            }catch(error){
              const message=error instanceof Error?error.message:String(error);delete results[index];delete relationResults[index];workStates[feature.id]={...workStates[feature.id],state:'failed',error:message,updatedAt:Date.now()};
              (cp.executionFailures??=[]).push({node:'audit',purpose:`evidence-audit-${feature.id}`,subjectId:feature.id,category:error instanceof ModelOutputValidationError?'validation':'runtime',message,at:Date.now()});failures.push({featureId:feature.id,message});
            }
            cp.auditBatchCount=Object.values(workStates).filter(item=>item.state==='succeeded').length;task.steps[4].note=`已核查 ${cp.auditBatchCount}/${task.project.features.length} 个功能的现有产物`;await checkpoint();
          });
          if(failures.length)throw new Error(`平台依据核查未完成：${failures.map(item=>`${item.featureId} ${item.message}`).join('；')}`);
          registerAuditIssues(cp.auditIssues,results.flat(),task.project);
          const existing=new Map((task.project.relations??[]).map(item=>[JSON.stringify([item.sourceRequirementId,item.targetRequirementId,item.kind,item.sourceRefs]),item]));
          for(const relation of relationResults.flat()){const key=JSON.stringify([relation.sourceRequirementId,relation.targetRequirementId,relation.kind,relation.sourceRefs]);if(!existing.has(key)){const added={...relation,id:nextId('REL-',[...existing.values()],4)};existing.set(key,added)}}
          task.project.relations=[...existing.values()];
        });
        await stage(5,async()=>{
          const scopes=mergeConfirmationScopes(planDetailRepairs(cp.auditIssues.filter(issue=>issue.disposition==='open'&&issue.owner!=='runtime-output'),task.project));
          const outcomes=await mapPool(scopes,pool,async scope=>{
            const base=structuredClone(task.project),before=base.requirements.filter(item=>scope.requirementIds.includes(item.id));
            try{
              const currentRequirements=before.map(item=>({...item,featureId:base.features.find(feature=>feature.requirementIds.includes(item.id))?.id}));
              const units=sourceUnits(scope.sourceUnitIds),patch=await call({contract:'repair',node:'repair',purpose:`evidence-repair-${scope.key}`,title:'有据修正',instruction:`只修正 issues 指出的无依据新增、原文误读、条件或例外缺失。不得补充未被 issues 指出的需求，不得扩大功能范围，不得调整细化颗粒度。保留正式 ID；新增内容不在本轮范围。输出 {"requirements":[],"deleteRequirementIds":[]}，条目遵循 ${detailSchema}`,input:{sourceUnits:units,features:base.features.filter(item=>scope.featureIds.includes(item.id)),currentRequirements,issues:scope.issues},accept:v=>acceptRequirementPatch(v,base,scope),images:[],preparedEvidence:false,materialize:materializeDetailEvidenceSelections});
              const resolvedUnitIds=new Set(units.map(item=>item.id)),candidate=applyRequirementPatch(base,scope,patch,false,resolvedUnitIds),changed=candidate.requirements.filter(item=>scope.requirementIds.includes(item.id));
              const review=await call({contract:'repairReview',node:'audit',purpose:`evidence-repair-review-${scope.key}`,title:'产物依据核查·修正复核',instruction:`只判断 originalIssues 是否已解决，以及本次修正是否新增无依据内容或曲解原文。不得寻找旁支遗漏，不得提出扩大细化范围的新问题。输出 ${repairReviewSchema}`,input:{sourceUnits:units,beforeRequirements:before,requirements:changed,originalIssues:scope.issues},accept:v=>acceptRepairReview(v,scope.issues,units,base.features,candidate.requirements,candidate.clarifications)});
              return review.originalIssueResults.every(item=>item.status==='resolved')&&!review.introducedIssues.length?{scope,patch,resolvedUnitIds}:{scope,error:'自动修正未通过依据复核'};
            }catch(error){return{scope,error:`${error instanceof Error?error.message:String(error)}`,executionFailure:true as const}}
          });
          // 模型生成和复核可并行；补丁必须按规划顺序应用到最新项目，避免整项目副本互相覆盖。
          for(const outcome of outcomes){
            if('patch' in outcome&&outcome.patch){cp.executionFailures=(cp.executionFailures??[]).filter(item=>!(item.node==='repair'&&item.subjectId===outcome.scope.key));task.project=applyRequirementPatch(task.project,outcome.scope,outcome.patch,true,outcome.resolvedUnitIds);for(const issue of outcome.scope.issues){const persisted=cp.auditIssues.find(item=>item.id===issue.id);if(persisted)closeIssue(persisted,'repaired')}cp.resultVersion=(cp.resultVersion??0)+1}
            else if('executionFailure' in outcome){
              cp.executionFailures=(cp.executionFailures??[]).filter(item=>!(item.node==='repair'&&item.subjectId===outcome.scope.key));
              cp.executionFailures.push({node:'repair',purpose:`evidence-repair-${outcome.scope.key}`,subjectId:outcome.scope.key,category:'runtime',message:outcome.error,at:Date.now()});
            } else for(const issue of outcome.scope.issues){const persisted=cp.auditIssues.find(item=>item.id===issue.id);if(persisted)persisted.detail=`${persisted.detail}；${outcome.error}`}
            await checkpoint();
          }
          const executionFailures=outcomes.filter(outcome=>'executionFailure' in outcome);
          if(executionFailures.length)throw new Error(`平台有据修正执行未完成：${executionFailures.map(outcome=>outcome.error).join('；')}`);
          const platformIssues=cp.auditIssues.filter(i=>i.disposition!=='repaired'&&i.disposition!=='dismissed');
          task.project.audit={passed:platformIssues.length===0,issues:cp.auditIssues};task.audit=task.project.audit;cp.verificationCompletedVersion=cp.resultVersion??0;cp.verificationDependencyHash=contentFingerprint(task.project);
        });
      await stage(6, async () => {
        graph();if(task.project.relations?.length)task.project.relations=acceptRequirementRelations(task.project.relations,task.project.sourceUnits,task.project.requirements);
        task.project.stage = 'review';const version=cp.resultVersion??0,ledger=requiredChecks(task.project,version),openIssues=(task.project.audit?.issues??[]).filter(i=>i.disposition!=='repaired'&&i.disposition!=='dismissed'),proofValid=cp.verificationCompletedVersion===version&&cp.verificationDependencyHash===contentFingerprint(task.project);
        ledger.source.status='passed';ledger.feature.status=!proofValid?'unknown':openIssues.some(i=>i.owner==='feature-grouping')?'failed':'passed';ledger.detail.status=!proofValid?'unknown':openIssues.some(i=>i.owner==='requirement-detail'||i.owner==='runtime-output')?'failed':'passed';ledger.relation.status=!proofValid||openIssues.some(i=>i.owner==='runtime-output')?'unknown':openIssues.some(i=>i.owner==='requirement-relation')?'failed':'passed';for(const item of Object.values(ledger))item.issueIds=openIssues.filter(issue=>item.id==='feature'?issue.owner==='feature-grouping':item.id==='detail'?issue.owner==='requirement-detail'||issue.owner==='runtime-output':item.id==='relation'?issue.owner==='requirement-relation'||issue.owner==='runtime-output':false).map(issue=>issue.id);cp.checks=ledger;
        const assessment=assessDelivery(task.project,cp.checks,version);task.project.delivery=assessment;const result = path.join(workspace, 'result'); await mkdir(result, { recursive: true });
        const packageRoot=path.join(result,assessment.state==='ready'?'deliveries':'drafts');
        this.assert(task, attempt); const intendedVersion=task.resultVersion??1,written=await writeAgentPackage(task.project,{...task,status:assessment.state==='ready'?'completed':task.status,resultVersion:intendedVersion},packageRoot);task.resultVersion=intendedVersion;task.artifacts=[...(task.artifacts??[]),{id:`A-${randomUUID().slice(0,8).toUpperCase()}`,kind:assessment.state==='ready'?'agent-package':'draft',path:written.directory,resultVersion:intendedVersion,createdAt:Date.now()}];
        this.assert(task, attempt); await this.writeAtomic(path.join(this.root, `${task.project.id}.project.json`), task.project);
      });
      this.assert(task, attempt); task.status = 'completed'; task.progress = 100;task.error=undefined; task.completedAt = Date.now();
      if(task.adjustment&&task.parentTaskId&&task.resultVersion===undefined){
        const rootTaskId=task.rootTaskId??task.parentTaskId,baseVersion=task.baseResultVersion??1;
        await this.withFamilyCommit(rootTaskId,async()=>{const latest=this.latestResult(rootTaskId);if(!latest||latest.id!==task.parentTaskId||latest.resultVersion!==baseVersion)throw new Error(`基础结果已更新：当前为第 ${latest?.resultVersion??baseVersion} 版；本次输入和候选已保留，请在最新版上重新提交`);task.resultVersion=baseVersion+1;await this.publish(task)});
      }else await this.publish(task);
    } catch (error) {
      if (task.attempt !== attempt) return;
      task.status = 'failed'; task.completedAt = Date.now(); const failure=error instanceof ModelOutputValidationError&&error.title&&error.purpose?`平台未能完成“${error.title}”（${error.purpose}）的输出校验：${error.message}`:error instanceof Error ? error.message : String(error);task.error=task.adjustment?`${failure}；本次调整输入已保存：${task.adjustment.feedback??task.adjustment.instruction??''}`:failure;
      task.steps[error instanceof ModelOutputValidationError&&error.stepIndex!==undefined?error.stepIndex:activeStage].status = 'failed';
      for (const step of task.steps) if (step.status === 'running') step.status = 'failed';
      await this.publish(task);
    } finally { await Promise.allSettled(runtimes.map(r => r.stop())); }
  }
  private async publish(task: AnalysisTask) {
    if(this.deletedFamilies.has(task.rootTaskId??task.id)||!this.tasks.has(task.id))return;
    const merged = new Map((task.runtimeMetrics ?? []).map(m => [m.sessionId, m]));
    for (const m of (this.running.get(task.id) ?? []).flatMap(r => r.metrics?.() ?? [])) merged.set(m.sessionId, m);
    task.runtimeMetrics = [...merged.values()]; const value = structuredClone(task); await this.save(value); this.emit(value);
  }
  private async writeAtomic(file: string, value: unknown) {
    const suffix = `${process.pid}.${randomUUID()}`, temp = `${file}.${suffix}.tmp`, backup = `${file}.${suffix}.bak`;
    await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    for(let attempt=0;attempt<5;attempt++)try{await rename(temp,file);return}catch(error){const code=(error as NodeJS.ErrnoException).code;if(process.platform!=='win32'||!['EPERM','EBUSY'].includes(code??'')||attempt===4)break;await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)))}
    try { await rename(temp, file); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code; if (code !== 'EPERM' && code !== 'EEXIST') throw error;
      let moved = false;
      try { await rename(file, backup); moved = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      try { await rename(temp, file); if (moved) await rm(backup, { force: true }); } catch (e) { if (moved) await rename(backup, file); throw e; }
    }
  }
  private save(task: AnalysisTask) {
    const value = structuredClone(task), previous = this.writes.get(task.id) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(() => this.writeAtomic(path.join(this.root, `${task.id}.json`), value));
    this.writes.set(task.id, write); return write;
  }
}
