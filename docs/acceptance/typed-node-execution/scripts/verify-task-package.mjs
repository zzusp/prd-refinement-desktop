import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseString} from 'fast-csv';
import ExcelJS from 'exceljs';

const [taskArgument,summaryArgument]=process.argv.slice(2);
assert(taskArgument&&summaryArgument,'参数：任务JSON路径 去敏摘要JSON路径');
const taskPath=path.resolve(taskArgument),summaryPath=path.resolve(summaryArgument);
assert(summaryPath.startsWith(path.resolve('docs/acceptance/typed-node-execution')+path.sep),'摘要必须在本轮验收目录');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const taskBytes=await readFile(taskPath),task=JSON.parse(taskBytes);
assert(['completed','needs-attention'].includes(task.status),'任务尚未产出终态结果');
const artifacts=task.artifacts.filter(item=>item.kind==='agent-package');assert.equal(artifacts.length,1);
const directory=path.resolve(artifacts[0].path),manifest=JSON.parse(await readFile(path.join(directory,'manifest.json')));
assert.equal(manifest.taskId,task.id);assert.equal(manifest.schemaVersion,2);
const files=[];
async function walk(at,relative=''){for(const item of await readdir(at,{withFileTypes:true})){const key=relative?`${relative}/${item.name}`:item.name;if(item.isDirectory())await walk(path.join(at,item.name),key);else {assert(item.isFile(),'交付目录不允许符号链接');files.push(key);}}}
await walk(directory);
assert.deepEqual([...manifest.files.map(item=>item.path)].sort(),files.filter(item=>item!=='manifest.json').sort(),'Manifest 必须覆盖全部文件且无重复');
let totalBytes=0;
for(const file of manifest.files){const full=path.resolve(directory,file.path);assert(full.startsWith(directory+path.sep),'Manifest 路径越界');const bytes=await readFile(full);assert.equal(bytes.length,file.size);assert.equal(hash(bytes),file.sha256);totalBytes+=bytes.length;}
const requirementBytes=await readFile(path.join(directory,'requirements.json')),requirements=JSON.parse(requirementBytes),pending=JSON.parse(await readFile(path.join(directory,'pending.json')));
assert.equal(hash(requirementBytes),manifest.resultHash);assert.equal(requirements.task.id,task.id);
assert.equal(requirements.delivery.state,manifest.qualityState);assert.equal(task.project.delivery.state,manifest.qualityState);
assert.equal(pending.items.length,manifest.pendingItemCount);
const requirementIds=requirements.requirements.map(item=>item.id);assert.equal(new Set(requirementIds).size,requirementIds.length);
assert.deepEqual([...requirementIds].sort(),task.project.requirements.filter(item=>item.deliveryScope!=='excluded').map(item=>item.id).sort());
const csv=await readFile(path.join(directory,'implementation.csv'),'utf8');
const rows=await new Promise((resolve,reject)=>{const result=[];parseString(csv,{headers:true,ignoreEmpty:false,trim:false}).on('data',row=>result.push(row)).on('error',reject).on('end',()=>resolve(result));});
assert.equal(rows.length,requirementIds.length);assert.deepEqual(rows.map(row=>row.requirement_id).sort(),[...requirementIds].sort());
const byId=new Map(requirements.requirements.map(item=>[item.id,item]));
for(const row of rows){
 assert.equal(Object.keys(row).length,19,'CSV 列数不符合交付协议');
 const requirement=byId.get(row.requirement_id),feature=requirements.features.find(item=>item.requirementIds.includes(requirement.id));assert(feature);
 assert.equal(row.delivery_id,manifest.deliveryId);assert.equal(row.result_hash,manifest.resultHash);assert.equal(row.feature_id,feature.id);
 assert.equal(row.title,requirement.title);assert.equal(row.behavior,requirement.behavior);assert.equal(row.requirement_review_state,requirement.state);
 assert.deepEqual(JSON.parse(row.conditions),requirement.conditions);assert.deepEqual(JSON.parse(row.constraints),requirement.constraints);assert.deepEqual(JSON.parse(row.explicit_acceptance_conditions),requirement.explicitAcceptanceConditions);
 assert.deepEqual(JSON.parse(row.context_refs),[`features/${feature.id}.md`,`requirements.json#${requirement.id}`]);
 const relationIds=requirements.relations.filter(item=>item.sourceRequirementId===requirement.id||item.targetRequirementId===requirement.id).map(item=>item.id);
 assert.deepEqual(JSON.parse(row.relation_ids),relationIds);
 const common=feature.kind==='constraint'?[]:requirements.features.filter(item=>item.kind==='constraint'&&item.appliesToFeatureIds?.includes(feature.id)).flatMap(item=>item.requirementIds);
 assert.deepEqual(JSON.parse(row.common_requirement_ids),common);
 const scope=new Set([requirement.id,feature.id,...requirement.sourceUnitIds]);
 assert.deepEqual(JSON.parse(row.pending_item_ids),pending.items.filter(item=>item.requirementIds?.includes(requirement.id)||(item.affectedIds??[]).some(id=>scope.has(id))).map(item=>item.id));
 assert.equal(row.implementation_status,'todo');assert.equal(row.acceptance_status,'not_run');
 for(const field of ['implementation_evidence','acceptance_evidence','blocker'])assert.equal(row[field],'');
}
const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(path.join(directory,'requirements.xlsx'));
assert.deepEqual(workbook.getWorksheet('需求明细').getColumn(1).values.slice(2).map(String).sort(),[...requirementIds].sort());
const receipts=Object.values(task.checkpoint.nodeReceipts),operationIds=[];
assert(receipts.length>0);
for(const receipt of receipts){assert.equal(receipt.status,'succeeded');assert(receipt.result!==undefined);for(const attempt of receipt.attempts){assert.equal(attempt.inFlight,false);for(let index=1;index<=attempt.calls;index++)operationIds.push(`${attempt.executionId}-${receipt.workItemId}-${receipt.inputHash.slice(0,16)}-try${index}`);}}
assert.equal(new Set(operationIds).size,operationIds.length,'回执推导 operationId 重复');
const metrics=task.checkpoint.promptMetrics.map(item=>item.sessionId);assert.equal(new Set(metrics).size,metrics.length,'实际 prompt metric operationId 重复');
assert.deepEqual([...metrics].sort(),[...operationIds].sort(),'实际发起 operationId 与回执调用数不一致');
const runtimeOperationIds=task.runtimeMetrics.map(item=>item.sessionId);
assert.equal(new Set(runtimeOperationIds).size,runtimeOperationIds.length,'Runtime 实际调用 operationId 重复');
assert.deepEqual([...runtimeOperationIds].sort(),[...operationIds].sort(),'Runtime 完成调用与成功回执不一致');
const originalTask=path.join(process.env.APPDATA,'prd-refinement-desktop/analysis-tasks/T-1F2FBCF6.json');
const originalDiagnostic=path.join(process.env.APPDATA,'prd-refinement-desktop/analysis-tasks/T-1F2FBCF6/diagnostics/prd-T-1F2FBCF6-a1-details-F-003-batch0-26-try2.json');
assert.equal(hash(await readFile(originalTask)),'7977bf23a93ec394a1415d84b2947c5675af81adfbfb3f93e211d68ed65e6de5');
assert.equal(hash(await readFile(originalDiagnostic)),'48ae22056e3408420f0ceb85cf6b160d8e2d99006ce227779745ae316b993331');
assert.equal(hash(await readFile(taskPath)),hash(taskBytes),'核验期间任务发生修改');
const summary={status:'passed',taskId:task.id,taskStatus:task.status,taskSha256:hash(taskBytes),deliveryId:manifest.deliveryId,qualityState:manifest.qualityState,manifestFileCount:manifest.files.length,totalFileCount:files.length,totalManifestBytes:totalBytes,requirements:requirementIds.length,csvRows:rows.length,xlsxRequirements:requirementIds.length,features:requirements.features.length,clarifications:requirements.clarifications.length,pendingItems:pending.items.length,receipts:receipts.length,operationCalls:operationIds.length,uniqueOperationIds:new Set(operationIds).size,resultHash:manifest.resultHash,allFileHashesAndSizesMatch:true,csvAllFieldsMatch:true,originalTaskUnchanged:true,originalDiagnosticUnchanged:true};
await mkdir(path.dirname(summaryPath),{recursive:true});await writeFile(summaryPath,JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary));
