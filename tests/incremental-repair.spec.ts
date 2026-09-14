import { describe,expect,it } from 'vitest';
import { acceptRequirementPatch,applyRequirementPatch,classifyIssues,planDetailRepairs } from '../electron/audit-repair';
import type { AuditIssue,Clarification,PrdProject,RequirementDetail } from '../src/types';

const requirement=(id:string,source:string):RequirementDetail=>({id,featureId:source==='S3'?'F2':'F1',text:'原文明示行为',sourceRefs:[{sourceUnitId:source}],state:'draft'});
function project():PrdProject{return{id:'P',name:'P',sourceName:'p.md',sourceHash:'x',revision:1,importedAt:'',rawText:'',stage:'review',sourceUnits:['S1','S2','S3'].map(id=>({id,label:id,excerpt:'原文明示行为',kind:'paragraph',location:id,status:'processed'})),sourceDispositions:['S1','S2','S3'].map(sourceUnitId=>({sourceUnitId,kind:'requirement',reason:'明确要求',featureIds:[sourceUnitId==='S3'?'F2':'F1']})),features:[{id:'F1',name:'F1',goal:'F1',sourceUnitIds:['S1','S2'],requirementIds:['R-0001','R-0009'],ruleIds:[],state:'draft'},{id:'F2',name:'F2',goal:'F2',sourceUnitIds:['S3'],requirementIds:['R-0010'],ruleIds:[],state:'draft'}],requirements:[requirement('R-0001','S1'),requirement('R-0009','S2'),requirement('R-0010','S3')],clarifications:[]}}
const issue=(id:string,affectedIds:string[],sourceUnitIds=['S1']):AuditIssue=>({id,affectedIds,sourceUnitIds,direction:'forward',type:'遗漏',detail:id,category:'detail-mismatch',disposition:'open'});
const empty=()=>({requirements:[],deleteRequirementIds:[],clarifications:[],deleteClarificationIds:[]});
const clarification=(overrides:Partial<Clarification>={}):Clarification=>({id:'LOCAL-Q1',question:'字段为空时系统应采用哪一种业务处理规则？',reason:'原文没有给出唯一处理口径',level:'blocking',knownFacts:'原文明确字段参与业务判断',unresolvedPoint:'字段为空时的处理规则',impact:'不同答案会改变系统处理结果',levelReason:'不回答会迫使开发 Agent 猜测业务规则',resolutionProposal:{recommendation:'字段为空或仅包含空格时，统一按空值处理并执行现有必填校验。',rationale:'原文明确字段参与业务判断，统一归一化可避免同义输入产生不同结果。',impact:'空字符串和纯空格会被拒绝。',confirmation:'确认两类输入均按空值处理。',alternatives:[],sourceRefs:[{sourceUnitId:'S1'}]},sourceRefs:[{sourceUnitId:'S1'}],affectedIds:['LOCAL-R1'],state:'open',...overrides});

describe('增量修正写集合与提交',()=>{
  it('保留原文选区，不扩张为整个来源',()=>{
    const p=project();p.requirements[0].sourceRefs=[{sourceUnitId:'S1',start:0,end:2}];
    const scope=planDetailRepairs([issue('A',['R-0001'])],p)[0];
    expect(acceptRequirementPatch({...empty(),requirements:[p.requirements[0]]},p,scope).requirements[0].sourceRefs).toEqual([{sourceUnitId:'S1',start:0,end:2}]);
  });
  it('独立范围可依次补各自缺口，范围外已有缺口不阻挡提交',()=>{
    const p=project();p.requirements=[p.requirements[0]];p.features[0].requirementIds=['R-0001'];p.features[1].requirementIds=[];
    const scopes=planDetailRepairs([issue('A',['S2'],['S2']),issue('B',['S3'],['S3'])],p);expect(scopes).toHaveLength(2);
    const afterA=applyRequirementPatch(p,scopes[0],{...empty(),requirements:[{...requirement('LOCAL-A','S2'),featureId:'F1'}]},true);
    const afterB=applyRequirementPatch(afterA,scopes[1],{...empty(),requirements:[{...requirement('LOCAL-B','S3'),featureId:'F2'}]},true);
    expect(afterB.requirements.flatMap(r=>r.sourceRefs.map(ref=>ref.sourceUnitId))).toEqual(['S1','S2','S3']);
    expect(()=>applyRequirementPatch(p,scopes[0],empty(),true)).toThrow('未覆盖原文：S2');
  });
  it('同一未承接来源的模型问题与脚本问题合并为一个修正范围',()=>{
    const p=project();p.requirements=[];p.features[0].requirementIds=[];p.features[1].requirementIds=[];
    const scopes=planDetailRepairs([issue('MODEL',['F1'],['S1']),issue('SCRIPT',['F1'],['S1'])],p);
    expect(scopes).toHaveLength(1);expect(scopes[0].issues.map(item=>item.id)).toEqual(['SCRIPT','MODEL']);expect(scopes[0].sourceUnitIds).toEqual(['S1']);
  });
  it('不同来源集合不会因共享功能被传递合并成过大修正范围',()=>{
    const p=project();p.requirements=[];p.features[0].requirementIds=[];p.features[1].requirementIds=[];
    const scopes=planDetailRepairs([issue('BROAD',['F1'],['S1','S2']),issue('S1',['F1'],['S1']),issue('S2',['F1'],['S2'])],p);
    expect(scopes).toHaveLength(3);expect(scopes.map(scope=>scope.sourceUnitIds)).toEqual([['S1','S2'],['S1'],['S2']]);
  });
  it('局部提交仍拒绝丢失原本已覆盖来源',()=>{
    const p=project(),scope=planDetailRepairs([issue('A',['R-0001'])],p)[0];
    expect(()=>applyRequirementPatch(p,scope,{...empty(),deleteRequirementIds:['R-0001']},true)).toThrow('未覆盖原文：S1');
  });
  it('同功能不同条目并行，相交写集合传递合并，不猜未分类问题',()=>{
    const p=project(),a=issue('A-0040',['R-0001']),b=issue('A-0041',['R-0009'],['S2']);
    expect(planDetailRepairs([a,b],p)).toHaveLength(2);
    expect(planDetailRepairs([a,b,issue('A-0042',['R-0001','R-0009'])],p)).toHaveLength(1);
    expect(planDetailRepairs([{...a,category:'unclassified'}],p)).toHaveLength(0);
    expect(classifyIssues([a,a,b],p).map(item=>item.id)).toEqual(['A-0040','A-0041']);
  });
  it('删除需求时原子清理引用该需求的关系',()=>{
    const p=project();p.relations=[{id:'REL-0001',sourceRequirementId:'R-0001',targetRequirementId:'R-0009',kind:'depends-on',sourceRefs:[{sourceUnitId:'S1'}]}];
    p.requirements[1].sourceRefs.push({sourceUnitId:'S1'});const scope=planDetailRepairs([issue('A',['R-0001'])],p)[0];
    const result=applyRequirementPatch(p,scope,{...empty(),deleteRequirementIds:['R-0001']},true);expect(result.relations).toEqual([]);
  });
  it('按受影响对象校正模型误报的处理责任，主功能归属问题单独回到功能边界',()=>{
    const p=project();
    const detail={...issue('DETAIL',['R-0001']),owner:'runtime-output' as const};
    const relation={...issue('ATTR',['R-0001','R-0009']),owner:'requirement-relation' as const,type:'requirement-attribution-error'};
    const ownership={...issue('OWNER',['R-0001']),owner:'requirement-detail' as const,type:'requirement-ownership-mismatch'};
    expect(classifyIssues([detail,relation,ownership],p).map(item=>[item.id,item.category,item.owner])).toEqual([
      ['DETAIL','detail-mismatch','requirement-detail'],
      ['ATTR','detail-mismatch','requirement-detail'],
      ['OWNER','feature-boundary','feature-grouping'],
    ]);
  });
  it('来源无法唯一定位功能时保留未决，澄清引用补足证据及写冲突',()=>{
    const p=project();p.features[1].sourceUnitIds.push('S1');
    expect(planDetailRepairs([issue('A',[])],p)).toEqual([]);
    p.clarifications.push(clarification({id:'Q-0005',affectedIds:['R-0001','S2']}));
    const scope=planDetailRepairs([issue('A',['Q-0005'])],p)[0];
    expect(scope.requirementIds).toEqual(['R-0001']);expect(scope.sourceUnitIds).toEqual(['S1','S2']);expect(scope.clarificationIds).toEqual(['Q-0005']);
  });
  it('平台发现既有澄清已过时时进入澄清修正范围',()=>{
    const p=project();p.clarifications.push(clarification({id:'Q-0005',affectedIds:['R-0001']}));
    const stale={...issue('STALE',['Q-0005','R-0001']),owner:'source-decision' as const};
    const scope=planDetailRepairs([stale],p)[0];
    expect(scope.clarificationIds).toEqual(['Q-0005']);expect(scope.requirementIds).toEqual(['R-0001']);
    expect(applyRequirementPatch(p,scope,{...empty(),deleteClarificationIds:['Q-0005']},true).clarifications).toEqual([]);
  });
  it('拒绝修改无关条目、越界来源、非LOCAL新增及移动主归属',()=>{
    const p=project(),scope=planDetailRepairs([issue('A',['R-0001'])],p)[0];
    expect(()=>acceptRequirementPatch({...empty(),requirements:[p.requirements[1]]},p,scope)).toThrow();
    expect(()=>acceptRequirementPatch({...empty(),requirements:[{...p.requirements[0],sourceUnitIds:['S3']}]},p,scope)).toThrow();
    expect(()=>acceptRequirementPatch({...empty(),requirements:[{...p.requirements[0],id:'R-0099'}]},p,scope)).toThrow('LOCAL-');
    expect(()=>acceptRequirementPatch({...empty(),requirements:[{...p.requirements[0],featureId:'F2'}]},p,scope)).toThrow();
  });
  it('预览保留LOCAL，提交从全局最大编号分配并重映射澄清引用',()=>{
    const p=project(),original=structuredClone(p),scope=planDetailRepairs([issue('A',['R-0001'])],p)[0];
    const patch=acceptRequirementPatch({...empty(),requirements:[{...p.requirements[0],id:'LOCAL-R1'}],clarifications:[clarification()]},p,scope);
    const preview=applyRequirementPatch(p,scope,patch,false);expect(preview.requirements.at(-1)?.id).toBe('LOCAL-R1');
    const result=applyRequirementPatch(p,scope,patch,true);expect(result.requirements.at(-1)?.id).toBe('R-0011');expect(result.clarifications[0].affectedIds).toEqual(['R-0011']);expect(result.features[0].requirementIds).toContain('R-0011');
    expect(result.requirements.find(item=>item.id==='R-0009')).toEqual(p.requirements[1]);expect(p).toEqual(original);
    const next=applyRequirementPatch(result,scope,{...patch,requirements:patch.requirements.map(item=>({...item,text:'另一个明确要求'})),clarifications:[]},true);expect(next.requirements.at(-1)?.id).toBe('R-0012');
    expect(()=>applyRequirementPatch(result,scope,patch,true)).toThrow('复制了范围外需求');
  });
  it('删除需求必须保持来源覆盖并显式修正所有引用它的澄清',()=>{
    const p=project();p.clarifications.push(clarification({id:'Q-0005',affectedIds:['R-0001']}));
    const scope=planDetailRepairs([issue('A',['R-0001'])],p)[0];
    const delta={...empty(),requirements:[{...p.requirements[0],id:'LOCAL-R1'}],deleteRequirementIds:['R-0001']};
    const patch=acceptRequirementPatch(delta,p,scope);
    expect(()=>applyRequirementPatch(p,scope,patch,true)).toThrow();
    const fixed=acceptRequirementPatch({...delta,clarifications:[{...p.clarifications[0],affectedIds:['LOCAL-R1']}]},p,scope);
    expect(applyRequirementPatch(p,scope,fixed,true).clarifications[0].affectedIds).toEqual(['R-0011']);
    const noCoverage=acceptRequirementPatch({...empty(),deleteRequirementIds:['R-0001'],deleteClarificationIds:['Q-0005']},p,scope);
    expect(()=>applyRequirementPatch(p,scope,noCoverage,true)).toThrow('未覆盖');
  });
  it('既有澄清保留只读需求引用，但不扩大写集合或允许新建关联',()=>{
    const p=project();p.clarifications.push(clarification({id:'Q-0005',question:'共享字段采用哪一种业务处理口径？',affectedIds:['R-0001','R-0009']}));
    const scope=planDetailRepairs([issue('A',['R-0001'])],p)[0];
    expect(scope.requirementIds).toEqual(['R-0001']);expect(scope.readOnlyRequirementIds).toEqual(['R-0009']);expect(scope.sourceUnitIds).toContain('S2');
    const delta={...empty(),requirements:[{...p.requirements[0],id:'LOCAL-R1'}],deleteRequirementIds:['R-0001'],clarifications:[{...p.clarifications[0],affectedIds:['R-0009']}]};
    const result=applyRequirementPatch(p,scope,acceptRequirementPatch(delta,p,scope),true);
    expect(result.clarifications[0].affectedIds).toEqual(['R-0009']);expect(result.requirements.find(item=>item.id==='R-0009')).toEqual(p.requirements[1]);
    expect(()=>acceptRequirementPatch({...empty(),requirements:[p.requirements[1]]},p,scope)).toThrow('越界修改');
    expect(()=>acceptRequirementPatch({...empty(),deleteRequirementIds:['R-0009']},p,scope)).toThrow('越界删除');
    expect(()=>acceptRequirementPatch({...empty(),clarifications:[{...p.clarifications[0],id:'LOCAL-Q1',affectedIds:['R-0009']}]},p,scope)).toThrow('引用越出修正范围');
    const merged=planDetailRepairs([issue('A',['R-0001']),issue('B',['R-0009'],['S2'])],p);
    expect(merged).toHaveLength(1);expect(merged[0].readOnlyRequirementIds).toEqual([]);
  });
});
