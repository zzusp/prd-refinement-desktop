import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseString } from 'fast-csv';
import type { AnalysisTask, PrdProject } from '../src/types';
import { writeAgentPackage } from '../electron/export-agent-package';
import { createTestWorkspace } from './test-workspace';

const roots:string[]=[];
afterAll(async()=>{await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})))});
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const parseCsv=(value:string)=>new Promise<Record<string,string>[]>((resolve,reject)=>{const rows:Record<string,string>[]=[];parseString(value,{headers:true}).on('error',reject).on('data',(row:Record<string,string>)=>rows.push(row)).on('end',()=>resolve(rows))});

function fixture(){
  const project:PrdProject={id:'P-1',name:'订单需求',sourceName:'prd.md',sourceHash:'input-hash',revision:2,importedAt:'2026-09-11T00:00:00.000Z',rawText:'提交订单。所有操作需登录。',stage:'review',sourceUnits:[
    {id:'S-1',label:'提交订单',kind:'paragraph',excerpt:'登录用户可以提交订单。',location:'第 1 段',status:'processed'},
    {id:'S-2',label:'通用约束',kind:'paragraph',excerpt:'所有操作需登录。',location:'第 2 段',status:'processed'}
  ],rules:[],features:[
    {id:'F-001',name:'提交订单',goal:'',sourceUnitIds:['S-1'],ruleIds:[],requirementIds:['R-001'],state:'reviewed'},
    {id:'F-900',kind:'constraint',name:'登录约束',goal:'',sourceUnitIds:['S-2'],ruleIds:[],requirementIds:['R-900'],appliesToFeatureIds:['F-001'],state:'reviewed'}
  ],requirements:[
    {id:'R-001',title:'提交订单',behavior:'用户提交订单',conditions:['用户已登录'],constraints:['库存不足时禁止提交'],explicitAcceptanceConditions:['提交成功后返回订单号'],sourceUnitIds:['S-1'],ruleIds:[],state:'reviewed'},
    {id:'R-900',title:'登录约束',behavior:'操作前校验登录状态',conditions:[],constraints:[],explicitAcceptanceConditions:[],sourceUnitIds:['S-2'],ruleIds:[],state:'reviewed'}
  ],clarifications:[],audit:{passed:true,issues:[]}};
  const task:AnalysisTask={id:'T-1',project,attempt:3,status:'completed',progress:100,createdAt:1,steps:[]};
  return {project,task};
}

describe('Agent 交付包',()=>{
  it('本期存在待处理事项时仍交付需求，并在机器入口保留级别、依据和影响',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);const {project,task}=fixture();
    const base={question:'是否需要在本期明确订单备注长度？',reason:'原文未明确',knownFacts:'订单可以提交',unresolvedPoint:'备注长度',impact:'不改变本期核心流程',levelReason:'已有明确默认口径',sourceRefs:[{sourceUnitId:'S-1'}],affectedIds:['R-001'],state:'open' as const};
    project.clarifications=[{id:'Q-S',level:'suggestion',defaultResolution:'暂不处理时保持原文规则',...base},{id:'Q-I',level:'ignorable',...base}];
    expect((await writeAgentPackage(project,task,root,'advisory')).manifest.qualityState).toBe('ready');
    project.clarifications.push({id:'Q-B',level:'blocking',...base,question:'库存不足时订单应进入哪一种业务状态？',impact:'会改变订单状态',levelReason:'开发 Agent 无法确定处理分支'});
    project.audit={passed:false,issues:[{id:'A-1',direction:'依据核查',type:'evidence',sourceUnitIds:['S-1'],affectedIds:['R-001'],detail:'提交条件的引用范围需要复核',disposition:'open'}]};
    const result=await writeAgentPackage(project,task,root,'with-open-items');
    const requirements=JSON.parse(await readFile(path.join(result.directory,'requirements.json'),'utf8'));
    const pending=JSON.parse(await readFile(path.join(result.directory,'pending.json'),'utf8'));
    const implementation=await parseCsv(await readFile(path.join(result.directory,'implementation.csv'),'utf8'));
    expect(result.manifest.qualityState).toBe('ready');
    expect(requirements.requirements.map((item:{id:string})=>item.id)).toContain('R-001');
    expect(pending.items).toEqual(expect.arrayContaining([expect.objectContaining({id:'Q-B',kind:'clarification',level:'blocking',impact:'会改变订单状态',evidence:[{sourceUnitId:'S-1'}]})]));
    expect(pending.items).toEqual(expect.arrayContaining([expect.objectContaining({id:'A-1',kind:'platform-issue',level:'blocking',evidence:[{sourceUnitId:'S-1'}]})]));
    expect(requirements.audit.issues.map((item:{id:string})=>item.id)).toContain('A-1');
    expect(JSON.parse(implementation.find(item=>item.requirement_id==='R-001')!.pending_item_ids)).toEqual(expect.arrayContaining(['Q-B','A-1']));
  });
  it('从同一快照生成、回读并原子发布完整需求包',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);
    const {project,task}=fixture();const assetPath=path.join(root,'原始图片.png'),asset=Buffer.from('fixture-image');await writeFile(assetPath,asset);project.sourceUnits[0].asset={path:assetPath,mimeType:'image/png',sha256:hash(asset),readStatus:'read'};const result=await writeAgentPackage(project,task,root,'delivery-1');
    expect(path.basename(result.directory)).toBe('delivery-1');expect(result.manifest.qualityState).toBe('ready');
    const names=(await readdir(result.directory)).sort();expect(names).toEqual(['README.md','features','implementation.csv','manifest.json','pending.json','requirements.json','requirements.xlsx','sources']);
    expect(result.manifest.schemaVersion).toBe(2);
    const requirements=JSON.parse(await readFile(path.join(result.directory,'requirements.json'),'utf8'));
    expect(requirements.requirements.map((item:{id:string})=>item.id)).toEqual(['R-001','R-900']);expect(requirements.delivery.state).toBe('ready');
    expect(requirements.sources[0].asset.path).toBe(`sources/assets/${hash(asset)}.png`);expect(JSON.stringify(requirements)).not.toContain(assetPath);
    const feature=await readFile(path.join(result.directory,'features','F-001.md'),'utf8');
    expect(feature).toContain('用户提交订单');expect(feature).toContain('## 适用的通用约束');expect(feature).toContain('操作前校验登录状态');
    const readme=await readFile(path.join(result.directory,'README.md'),'utf8');expect(readme).toContain('(features/F-001.md)');
    expect(readme).toContain('implementation.csv');expect(readme).toContain('implemented + passed');
    const implementation=await parseCsv(await readFile(path.join(result.directory,'implementation.csv'),'utf8'));
    expect(implementation.map(item=>item.requirement_id)).toEqual(['R-001','R-900']);
    expect(implementation[0]).toMatchObject({delivery_id:'delivery-1',result_hash:result.manifest.resultHash,feature_id:'F-001',behavior:'用户提交订单',conditions:'["用户已登录"]',constraints:'["库存不足时禁止提交"]',explicit_acceptance_conditions:'["提交成功后返回订单号"]',common_requirement_ids:'["R-900"]',implementation_status:'todo',implementation_evidence:'',acceptance_status:'not_run',acceptance_evidence:'',blocker:''});
    expect(JSON.parse(implementation[0].context_refs)).toEqual(['features/F-001.md','requirements.json#R-001']);
    for(const file of result.manifest.files){const data=await readFile(path.join(result.directory,...file.path.split('/')));expect(hash(data)).toBe(file.sha256);expect(data.length).toBe(file.size)}
    expect((await readdir(root)).some(name=>name.endsWith('.tmp'))).toBe(false);
  });

  it('工作清单使用标准 CSV 保留中文标点、引号和多行条款',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);const {project,task}=fixture();
    project.requirements[0].behavior='用户填写“名称,规格”后提交\n系统保留原始换行';
    project.requirements[0].conditions=['状态为“启用,待审”','第二行\n仍属同一条件'];
    project.requirements[0].explicitAcceptanceConditions=[];
    const result=await writeAgentPackage(project,task,root,'csv-roundtrip');
    const rows=await parseCsv(await readFile(path.join(result.directory,'implementation.csv'),'utf8'));
    expect(rows[0].behavior).toBe(project.requirements[0].behavior);
    expect(JSON.parse(rows[0].conditions)).toEqual(project.requirements[0].conditions);
    expect(JSON.parse(rows[0].explicit_acceptance_conditions)).toEqual([]);
  });

  it('范围来自持久化需求字段，功能内可只排除部分需求',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);
    const {project,task}=fixture();
    project.sourceUnits.push({id:'S-3',label:'取消订单',kind:'paragraph',excerpt:'用户可以取消订单。',location:'第 3 段',status:'processed'});
    project.features.push({id:'F-002',name:'取消订单',goal:'',sourceUnitIds:['S-3'],ruleIds:[],requirementIds:['R-002','R-003'],state:'reviewed'});
    project.requirements.push({id:'R-002',title:'取消订单',behavior:'用户取消订单',conditions:[],constraints:[],explicitAcceptanceConditions:[],sourceUnitIds:['S-3'],ruleIds:[],state:'needs-clarification',deliveryScope:'excluded'});
    project.requirements.push({id:'R-003',title:'查看取消结果',behavior:'用户查看取消结果',conditions:[],constraints:[],explicitAcceptanceConditions:[],sourceUnitIds:['S-3'],ruleIds:[],state:'reviewed'});
    project.clarifications.push({id:'Q-B',level:'blocking',question:'取消后库存如何处理？',reason:'原文未明确',affectedIds:['R-002'],state:'open'});
    const result=await writeAgentPackage(project,task,root,'scoped', {selectedFeatureIds:['F-001','F-002']});
    const requirements=JSON.parse(await readFile(path.join(result.directory,'requirements.json'),'utf8'));
    const pending=JSON.parse(await readFile(path.join(result.directory,'pending.json'),'utf8'));
    const implementation=await parseCsv(await readFile(path.join(result.directory,'implementation.csv'),'utf8'));
    expect(result.manifest.selectedFeatureIds).toEqual(['F-001','F-002']);
    expect(result.manifest.executableFeatureIds).toEqual(['F-001','F-002']);
    expect(result.manifest.blockedFeatureIds).toEqual([]);
    expect(requirements.features.map((item:{id:string})=>item.id)).toEqual(['F-001','F-002','F-900']);
    expect(requirements.requirements.map((item:{id:string})=>item.id)).toEqual(['R-001','R-900','R-003']);
    expect(pending.items).toEqual(expect.arrayContaining([expect.objectContaining({id:'R-002',kind:'excluded-requirement'})]));
    expect(await readdir(path.join(result.directory,'features'))).toEqual(expect.arrayContaining(['F-001.md','F-900.md']));
    expect(await readdir(path.join(result.directory,'features'))).toContain('F-002.md');
    const workbook=new (await import('exceljs')).default.Workbook();await workbook.xlsx.readFile(path.join(result.directory,'requirements.xlsx'));
    expect(JSON.stringify(workbook.getWorksheet('阅读说明与汇总')!.getSheetValues())).toContain('F-001、F-002');
    expect(JSON.stringify(workbook.getWorksheet('阅读说明与汇总')!.getSheetValues())).toContain('可执行功能');
  });

  it('本期需求依赖范围外需求时保留本期需求并记录未满足依赖',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);
    const {project,task}=fixture();
    project.sourceUnits.push({id:'S-3',label:'支付',kind:'paragraph',excerpt:'订单提交后发起支付。',location:'第 3 段',status:'processed'});
    project.features.push({id:'F-002',name:'支付',goal:'',sourceUnitIds:['S-3'],ruleIds:[],requirementIds:['R-002'],state:'reviewed'});
    project.requirements.push({id:'R-002',title:'发起支付',behavior:'发起支付',conditions:[],constraints:[],explicitAcceptanceConditions:[],sourceUnitIds:['S-3'],ruleIds:[],state:'needs-clarification',deliveryScope:'excluded'});
    project.relations=[{id:'REL-1',sourceRequirementId:'R-001',targetRequirementId:'R-002',kind:'depends-on',sourceRefs:[{sourceUnitId:'S-3'}]}];
    const result=await writeAgentPackage(project,task,root,'dependency', {selectedFeatureIds:['F-001','F-002']});
    const requirements=JSON.parse(await readFile(path.join(result.directory,'requirements.json'),'utf8'));
    const pending=JSON.parse(await readFile(path.join(result.directory,'pending.json'),'utf8'));
    const implementation=await parseCsv(await readFile(path.join(result.directory,'implementation.csv'),'utf8'));
    expect(result.manifest.executableFeatureIds).toEqual(['F-001']);
    expect(result.manifest.blockedFeatureIds).toEqual([]);
    expect(requirements.requirements.map((item:{id:string})=>item.id)).toContain('R-001');
    expect(requirements.requirements.map((item:{id:string})=>item.id)).not.toContain('R-002');
    expect(pending.items).toEqual(expect.arrayContaining([expect.objectContaining({id:'REL-1',kind:'unmet-dependency',requirementIds:['R-001','R-002']})]));
    expect(result.manifest.unmetDependencyCount).toBe(1);
    expect(result.manifest.qualityState).toBe('ready');
    expect(JSON.parse(implementation.find(item=>item.requirement_id==='R-001')!.pending_item_ids)).toContain('REL-1');
  });

  it('功能级排除覆盖需求默认范围，且零本期需求明确失败',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);
    const {project,task}=fixture();project.features[0].deliveryScope='excluded';
    await expect(writeAgentPackage(project,task,root,'empty-current')).rejects.toThrow('本期范围没有可交付需求');
  });

  it('目标目录已存在时不覆盖旧包，并清理临时目录',async()=>{
    const root=await createTestWorkspace('prd-agent-package');roots.push(root);
    const {project,task}=fixture();await writeAgentPackage(project,task,root,'stable');
    const original=await readFile(path.join(root,'stable','requirements.json'),'utf8');
    await expect(writeAgentPackage(project,task,root,'stable')).rejects.toThrow();
    expect(await readFile(path.join(root,'stable','requirements.json'),'utf8')).toBe(original);
    expect((await readdir(root)).filter(name=>name.endsWith('.tmp'))).toEqual([]);
  });
});
