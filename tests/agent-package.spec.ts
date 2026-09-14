import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseString } from 'fast-csv';
import type { AnalysisTask, PrdProject } from '../src/types';
import { packageQuality, writeAgentPackage } from '../electron/export-agent-package';
import { createTestWorkspace } from './test-workspace';

const roots:string[]=[];
afterAll(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})))});
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const parseCsv=(value:string)=>new Promise<Record<string,string>[]>((resolve,reject)=>{const rows:Record<string,string>[]=[];parseString(value,{headers:true}).on('error',reject).on('data',(row:Record<string,string>)=>rows.push(row)).on('end',()=>resolve(rows))});

async function fixture(root:string){
  const project:PrdProject={id:'P-1',name:'订单需求',sourceName:'prd.md',sourceHash:'input-hash',revision:2,importedAt:'2026-09-11T00:00:00.000Z',rawText:'提交订单。所有操作需登录。',stage:'review',sourceUnits:[
    {id:'S-1',label:'提交订单',kind:'paragraph',excerpt:'登录用户可以提交订单。',location:'第 1 段',status:'processed'},
    {id:'S-2',label:'通用约束',kind:'paragraph',excerpt:'所有操作需登录。',location:'第 2 段',status:'processed'}
  ],rules:[],features:[
    {id:'F-001',name:'提交订单',goal:'',sourceUnitIds:['S-1'],ruleIds:[],requirementIds:['R-001'],state:'reviewed'},
    {id:'F-900',kind:'constraint',name:'登录约束',goal:'',sourceUnitIds:['S-2'],ruleIds:[],requirementIds:['R-900'],appliesToFeatureIds:['F-001'],state:'reviewed'}
  ],requirements:[
    {id:'R-001',featureId:'F-001',text:'用户提交订单',sourceRefs:[{sourceUnitId:'S-1'}],state:'reviewed'},
    {id:'R-900',featureId:'F-900',text:'操作前校验登录状态',sourceRefs:[{sourceUnitId:'S-2'}],state:'reviewed'}
  ],clarifications:[],audit:{passed:true,issues:[]}};
  const task:AnalysisTask={id:'T-1',project,attempt:3,status:'completed',progress:100,createdAt:1,steps:[]};
  project.inputSnapshotPath=path.join(root,'snapshot');await mkdir(path.join(project.inputSnapshotPath,'input'),{recursive:true});await writeFile(path.join(project.inputSnapshotPath,'input','prd.md'),project.rawText);
  return {project,task};
}

describe('Agent 交付包',()=>{
  it('包质量保留真实执行与检查状态，历史业务问题不参与新清单交付',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);const {project,task}=await fixture(root);
    project.clarifications=[{id:'Q',question:'如何处理？',reason:'待确认',level:'blocking',affectedIds:['R-001'],state:'open'}];
    expect(packageQuality(task,project).state).toBe('ready');
    delete project.audit;expect(packageQuality(task,project).state).toBe('unchecked');
    project.delivery={state:'unchecked',inputHash:'x',resultHash:'y',issueIds:[],unverifiedScopeIds:[],policyVersion:2};
    project.audit={passed:true,issues:[]};expect(packageQuality(task,project).state).toBe('unchecked');
    task.status='failed';expect(packageQuality(task,project).state).toBe('blocked');
    task.status='completed';project.delivery.state='ready';
    project.audit={passed:false,issues:[{id:'A',direction:'核查',type:'evidence',sourceUnitIds:['S-1'],affectedIds:['R-001'],detail:'引用未通过',disposition:'open'}]};
    expect(packageQuality(task,project)).toMatchObject({state:'blocked',issueIds:['A']});
    project.audit={passed:true,issues:[]};project.delivery.unverifiedScopeIds=['F-001'];
    expect(packageQuality(task,project).state).toBe('unchecked');
  });
  it('执行失败不能由导出范围投影改成 ready',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);const {project,task}=await fixture(root);
    task.status='failed';task.error='审计节点失败';
    const result=await writeAgentPackage(project,task,root,'failed-draft');
    expect(result.manifest.qualityState).toBe('blocked');
    const snapshot=JSON.parse(await readFile(path.join(result.directory,'requirements.json'),'utf8'));
    expect(snapshot.delivery.state).toBe('blocked');
  });
  it('严格要求冻结原始文件，不允许用转录代替；新包不输出历史建议与用户决定',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);const {project,task}=await fixture(root);
    const snapshot=project.inputSnapshotPath;delete project.inputSnapshotPath;
    await expect(writeAgentPackage(project,task,root,'missing-snapshot')).rejects.toThrow('缺少冻结原始资料');
    project.inputSnapshotPath=snapshot;project.sourceUnits[0].logicalPath='missing.md';
    await expect(writeAgentPackage(project,task,root,'missing-file')).rejects.toThrow('冻结原始文件缺失');
    delete project.sourceUnits[0].logicalPath;
    const item={id:'Q-1',question:'退款口径？',reason:'原文未定',affectedIds:['R-001'],sourceRefs:[{sourceUnitId:'S-1'}],state:'open' as const,resolutionProposal:{recommendation:'含税',rationale:'账务一致',impact:'包含税额',confirmation:'确认口径',alternatives:['不含税'],sourceRefs:[{sourceUnitId:'S-1'}]},userDecision:{text:'不含税',confirmedAt:'2026-09-14',status:'pending-prd-sync' as const,operationId:'OP-1'}};
    project.clarifications=[item];const result=await writeAgentPackage(project,task,root,'decided');
    expect(await readdir(result.directory)).not.toContain('pending.json');
    const requirements=JSON.parse(await readFile(path.join(result.directory,'requirements.json'),'utf8'));
    expect(Object.keys(requirements)).toEqual(['schemaVersion','project','task','delivery','features','requirements','sources']);
    expect(Object.keys(requirements.requirements[0])).toEqual(['id','featureId','text','sourceRefs']);
    expect(Object.keys(requirements.features[0])).toEqual(['id','name','sourceRefs','requirementIds']);
    const exported=[await readFile(path.join(result.directory,'README.md'),'utf8'),await readFile(path.join(result.directory,'features','F-001.md'),'utf8'),JSON.stringify(requirements),JSON.stringify(result.manifest)].join('\n');
    for(const legacy of ['clarifications','resolutionProposal','userDecision','pendingItemCount','unmetDependencyCount','blockedFeatureIds','退款口径？','不含税'])expect(exported).not.toContain(legacy);
    expect(project.clarifications).toEqual([item]);expect(project.requirements[0].text).toBe('用户提交订单');
  });
  it('历史问题不输出，平台校验失败仍将清单标记为草稿并保留任务诊断',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);const {project,task}=await fixture(root);
    const base={question:'是否需要在本期明确订单备注长度？',reason:'原文未明确',knownFacts:'订单可以提交',unresolvedPoint:'备注长度',impact:'不改变本期核心流程',levelReason:'已有明确默认口径',sourceRefs:[{sourceUnitId:'S-1'}],affectedIds:['R-001'],state:'open' as const};
    project.clarifications=[{id:'Q-S',level:'suggestion',defaultResolution:'暂不处理时保持原文规则',...base},{id:'Q-I',level:'ignorable',...base}];
    expect((await writeAgentPackage(project,task,root,'advisory')).manifest.qualityState).toBe('ready');
    project.clarifications.push({id:'Q-B',level:'blocking',...base,question:'库存不足时订单应进入哪一种业务状态？',impact:'会改变订单状态',levelReason:'开发 Agent 无法确定处理分支'});
    project.audit={passed:false,issues:[{id:'A-1',direction:'依据核查',type:'evidence',sourceUnitIds:['S-1'],affectedIds:['R-001'],detail:'提交条件的引用范围需要复核',disposition:'open'}]};
    const result=await writeAgentPackage(project,task,root,'with-open-items');
    const requirements=JSON.parse(await readFile(path.join(result.directory,'requirements.json'),'utf8'));
    expect(result.manifest.qualityState).toBe('blocked');
    expect(requirements.requirements.map((item:{id:string})=>item.id)).toContain('R-001');
    expect(requirements.delivery.state).toBe('blocked');
    expect(await readdir(result.directory)).not.toContain('pending.json');
    expect(requirements).not.toHaveProperty('audit');
    expect(requirements).not.toHaveProperty('clarifications');
    expect(project.audit.issues.map(item=>item.id)).toContain('A-1');
    expect(await readFile(path.join(result.directory,'README.md'),'utf8')).toContain('不能作为正式交付包');
  });
  it('从同一快照生成、回读并原子发布完整需求包',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);
    const {project,task}=await fixture(root);const assetPath=path.join(root,'原始图片.png'),asset=Buffer.from('fixture-image');await writeFile(assetPath,asset);project.sourceUnits[0].asset={path:assetPath,mimeType:'image/png',sha256:hash(asset),readStatus:'read'};const result=await writeAgentPackage(project,task,root,'delivery-1');
    expect(path.basename(result.directory)).toBe('delivery-1');expect(result.manifest.qualityState).toBe('ready');
    const names=(await readdir(result.directory)).sort();expect(names).toEqual(['README.md','checklist.csv','checklist.xlsx','features','manifest.json','requirements.json','sources']);
    expect(result.manifest.schemaVersion).toBe(4);
    const requirements=JSON.parse(await readFile(path.join(result.directory,'requirements.json'),'utf8'));
    expect(requirements.requirements.map((item:{id:string})=>item.id)).toEqual(['R-001','R-900']);expect(requirements.delivery.state).toBe('ready');
    expect(requirements.sources[0].asset.path).toBe(`sources/assets/${hash(asset)}.png`);expect(JSON.stringify(requirements)).not.toContain(assetPath);
    const feature=await readFile(path.join(result.directory,'features','F-001.md'),'utf8');
    expect(feature).toContain('用户提交订单');expect(feature).not.toContain('## 适用的通用约束');
    expect(await readFile(path.join(result.directory,'features','F-900.md'),'utf8')).toContain('操作前校验登录状态');
    const readme=await readFile(path.join(result.directory,'README.md'),'utf8');expect(readme).toContain('(features/F-001.md)');
    expect(readme).toContain('checklist.csv');expect(readme).toContain('先完整阅读');
    const implementation=await parseCsv(await readFile(path.join(result.directory,'checklist.csv'),'utf8'));
    expect(implementation.map(item=>item.requirement_id)).toEqual(['R-001','R-900']);
    expect(implementation[0]).toMatchObject({feature_id:'F-001',requirement:'用户提交订单',check_status:'unchecked',notes:''});
    expect(Object.keys(implementation[0])).toEqual(['feature_id','feature_source','requirement_id','requirement','source_location','check_status','notes']);
    expect(implementation[0].source_location).toContain('sources/files/prd.md');
    expect(await readFile(path.join(result.directory,'sources','files','prd.md'),'utf8')).toBe(project.rawText);
    for(const file of result.manifest.files){const data=await readFile(path.join(result.directory,...file.path.split('/')));expect(hash(data)).toBe(file.sha256);expect(data.length).toBe(file.size)}
    expect((await readdir(root)).some(name=>name.endsWith('.tmp'))).toBe(false);
  });

  it('工作清单使用标准 CSV 保留中文标点、引号和多行条款',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);const {project,task}=await fixture(root);
    project.requirements[0].text='用户填写“名称,规格”后提交\n系统保留原始换行';
    const result=await writeAgentPackage(project,task,root,'csv-roundtrip');
    const rows=await parseCsv(await readFile(path.join(result.directory,'checklist.csv'),'utf8'));
    expect(rows[0].requirement).toBe(project.requirements[0].text);
  });

  it('范围来自持久化需求字段，功能内可只排除部分需求',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);
    const {project,task}=await fixture(root);
    project.sourceUnits.push({id:'S-3',label:'取消订单',kind:'paragraph',excerpt:'用户可以取消订单。',location:'第 3 段',status:'processed'});
    project.features.push({id:'F-002',name:'取消订单',goal:'',sourceUnitIds:['S-3'],ruleIds:[],requirementIds:['R-002','R-003'],state:'reviewed'});
    project.requirements.push({id:'R-002',featureId:'F-002',text:'用户取消订单',sourceRefs:[{sourceUnitId:'S-3'}],state:'needs-clarification',deliveryScope:'excluded'});
    project.requirements.push({id:'R-003',featureId:'F-002',text:'用户查看取消结果',sourceRefs:[{sourceUnitId:'S-3'}],state:'reviewed'});
    project.clarifications.push({id:'Q-B',level:'blocking',question:'取消后库存如何处理？',reason:'原文未明确',affectedIds:['R-002'],state:'open'});
    const result=await writeAgentPackage(project,task,root,'scoped', {selectedFeatureIds:['F-001','F-002']});
    const requirements=JSON.parse(await readFile(path.join(result.directory,'requirements.json'),'utf8'));
    expect(result.manifest.selectedFeatureIds).toEqual(['F-001','F-002']);
    expect(requirements.features.map((item:{id:string})=>item.id)).toEqual(['F-001','F-002','F-900']);
    expect(requirements.requirements.map((item:{id:string})=>item.id)).toEqual(['R-001','R-900','R-003']);
    expect(await readdir(result.directory)).not.toContain('pending.json');
    expect(await readdir(path.join(result.directory,'features'))).toEqual(expect.arrayContaining(['F-001.md','F-900.md']));
    expect(await readdir(path.join(result.directory,'features'))).toContain('F-002.md');
    const workbook=new (await import('exceljs')).default.Workbook();await workbook.xlsx.readFile(path.join(result.directory,'checklist.xlsx'));
    expect(workbook.getWorksheet('需求清单')?.rowCount).toBe(4);
    expect(workbook.worksheets.map(sheet=>sheet.name)).toEqual(['需求清单','阅读说明']);
  });

  it('仅输出本期模块与需求，不将历史关系转成待处理事项',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);
    const {project,task}=await fixture(root);
    project.sourceUnits.push({id:'S-3',label:'支付',kind:'paragraph',excerpt:'订单提交后发起支付。',location:'第 3 段',status:'processed'});
    project.features.push({id:'F-002',name:'支付',goal:'',sourceUnitIds:['S-3'],ruleIds:[],requirementIds:['R-002'],state:'reviewed'});
    project.requirements.push({id:'R-002',featureId:'F-002',text:'发起支付',sourceRefs:[{sourceUnitId:'S-3'}],state:'needs-clarification',deliveryScope:'excluded'});
    project.relations=[{id:'REL-1',sourceRequirementId:'R-001',targetRequirementId:'R-002',kind:'depends-on',sourceRefs:[{sourceUnitId:'S-3'}]}];
    const result=await writeAgentPackage(project,task,root,'dependency', {selectedFeatureIds:['F-001','F-002']});
    const requirements=JSON.parse(await readFile(path.join(result.directory,'requirements.json'),'utf8'));
    expect(result.manifest.selectedFeatureIds).toEqual(['F-001']);
    expect(requirements.requirements.map((item:{id:string})=>item.id)).toContain('R-001');
    expect(requirements.requirements.map((item:{id:string})=>item.id)).not.toContain('R-002');
    expect(requirements).not.toHaveProperty('relations');
    expect(await readdir(result.directory)).not.toContain('pending.json');
    expect(result.manifest.qualityState).toBe('ready');
  });

  it('功能级排除覆盖需求默认范围，且零本期需求明确失败',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);
    const {project,task}=await fixture(root);project.features[0].deliveryScope='excluded';
    await expect(writeAgentPackage(project,task,root,'empty-current')).rejects.toThrow('本期范围没有可交付需求');
  });

  it('目标目录已存在时不覆盖旧包，并清理临时目录',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);
    const {project,task}=await fixture(root);await writeAgentPackage(project,task,root,'stable');
    const original=await readFile(path.join(root,'stable','requirements.json'),'utf8');
    await expect(writeAgentPackage(project,task,root,'stable')).rejects.toThrow();
    expect(await readFile(path.join(root,'stable','requirements.json'),'utf8')).toBe(original);
    expect((await readdir(root)).filter(name=>name.endsWith('.tmp'))).toEqual([]);
  });
});
