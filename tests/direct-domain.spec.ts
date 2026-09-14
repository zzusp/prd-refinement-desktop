import { describe, expect, it } from 'vitest';
import { acceptAuditIssues, acceptCandidateClassificationIssues, acceptDirectClarifications, acceptDirectDetails, acceptDirectFeatureBatch, acceptDirectFeatures, acceptFeatureUnification, acceptRequirementRelations, validateDirectGraph } from '../electron/domain';
import type { Feature, RequirementDetail, SourceDisposition, SourceUnit } from '../src/types';

const sources:SourceUnit[]=['S1','S2','S3'].map(id=>({id,label:id,kind:'paragraph',excerpt:'字段 X 必填',location:id,status:'processed'}));
const feature=(id:string,sourceUnitIds:string[],requirementIds:string[]=[]):Feature=>({id,name:id,goal:id,sourceUnitIds,requirementIds,ruleIds:[],state:'draft'});
const requirement:RequirementDetail={id:'R1',featureId:'F1',text:'字段 X 必填',sourceRefs:[{sourceUnitId:'S1'}],state:'draft'};
const dispositions:SourceDisposition[]=sources.map((unit,i)=>({sourceUnitId:unit.id,kind:i===0?'requirement':'context',reason:'原文分类',featureIds:i===0?['F1']:[]}));
const graph=(features:Feature[],requirements:RequirementDetail[]=[requirement],ds=dispositions)=>validateDirectGraph(sources,ds,features,requirements,[]);
const proposal={recommendation:'字段为空或仅包含空格时，统一按空值处理并执行现有必填校验。',rationale:'原文已明确该字段参与业务判断，统一归一化可避免同义输入产生不同结果。',impact:'空字符串和纯空格会被拒绝，不再作为有效值进入后续流程。',confirmation:'确认空字符串和纯空格均按空值处理。',alternatives:[],evidenceIds:['S1']};

describe('直接需求域契约',()=>{
  it('用户确认仅保留待同步口径且不能替代主 PRD 依据',()=>{
    const q={id:'Q1',question:'待确认',reason:'未明确',affectedIds:['S2'],state:'open' as const,userDecision:{text:'新增处理决定',confirmedAt:'2026-09-14T00:00:00.000Z',status:'pending-prd-sync' as const,operationId:'OP1'}};
    expect(validateDirectGraph(sources,dispositions,[feature('F1',['S1'],['R1'])],[requirement],[q]).uncovered).toEqual([]);
    expect(()=>validateDirectGraph(sources,dispositions,[feature('F1',['S1'],['R1'])],[requirement],[{...q,userDecision:{...q.userDecision,confirmedAt:'bad'}}])).toThrow('确认时间');
    expect(()=>validateDirectGraph(sources.map(s=>({...s,sourceRole:'supplement' as const})),dispositions,[feature('F1',['S1'],['R1'])],[requirement],[q])).toThrow('主 PRD');
  });
  it('领域入口拒绝创建业务问题，原文歧义不能变成平台审计事项',()=>{
    const question={id:'Q1',question:'字段为空时如何处理？',sourceRefs:[{sourceUnitId:'S1'}],affectedIds:['R1'],state:'open'};
    expect(acceptDirectClarifications([],sources,['R1'])).toEqual([]);
    expect(()=>acceptDirectClarifications([question],sources,['R1'])).toThrow('不允许生成澄清');
    expect(()=>acceptDirectDetails([requirement],[question],sources)).toThrow('不允许生成待处理事项');
    expect(()=>acceptDirectFeatureBatch([],sources.map(unit=>({sourceUnitId:unit.id,contentRole:'clarification',reason:'未明确',featureIds:[]})),sources)).toThrow('不允许将原文分类为待澄清');
    const issue={id:'LOCAL-A',direction:'forward',type:'来源歧义',category:'source-ambiguity',sourceUnitIds:['S1'],affectedIds:['R1'],detail:'空值处理口径未明确'};
    expect(()=>acceptAuditIssues([issue],sources,[],[feature('F1',['S1'],['R1'])],[requirement],[])).toThrow('分类非法');
    expect(()=>acceptAuditIssues([{...issue,category:'detail-mismatch',clarification:question}],sources,[],[],[requirement],[])).toThrow('平台清单偏差字段');
  });
  it('紧凑统一按显式单目标映射确定性合并全部来源',()=>{
    const {sourceUnitIds:_,...compact}=feature('F1',['S1']);
    const result=acceptFeatureUnification({features:[compact],candidateMappings:[{candidateId:'C1',featureIds:['F1']},{candidateId:'C2',featureIds:['F1']}]},[feature('C1',['S1']),feature('C2',['S2'])],sources);
    expect(result[0].sourceUnitIds).toEqual(['S1','S2']);
  });
  it('紧凑多目标仅按完整有效来源分配编译',()=>{
    const compact=(id:string)=>{const {sourceUnitIds:_,...f}=feature(id,[]);return f};
    const payload={features:[compact('F1'),compact('F2')],candidateMappings:[{candidateId:'C1',featureIds:['F1','F2'],sourceRefsByFeature:{F1:[{sourceUnitId:'S1'}],F2:[{sourceUnitId:'S2'}]}}]};
    const candidates=[feature('C1',['S1','S2'])];expect(acceptFeatureUnification(payload,candidates,sources).map(f=>f.sourceUnitIds)).toEqual([['S1'],['S2']]);
    for(const allocation of [undefined,{F1:[{sourceUnitId:'S1'}],F2:[{sourceUnitId:'S1'}]},{F1:[{sourceUnitId:'S1'}],F2:[{sourceUnitId:'S3'}]},{F1:[{sourceUnitId:'S1'}]},{F1:[{sourceUnitId:'S1'}],F2:[]}])expect(()=>acceptFeatureUnification({...payload,candidateMappings:[{...payload.candidateMappings[0],sourceRefsByFeature:allocation}]},candidates,sources)).toThrow();
  });
  it('紧凑与显式来源不可混用，显式遗漏不能被脚本补齐',()=>{
    const {sourceUnitIds:_,...compact}=feature('F1',[]),candidateMappings=[{candidateId:'C1',featureIds:['F1']},{candidateId:'C2',featureIds:['F2']}],candidates=[feature('C1',['S1','S2']),feature('C2',['S3'])];
    expect(()=>acceptFeatureUnification({features:[compact,feature('F2',['S3'])],candidateMappings},candidates,sources)).toThrow('不允许混用');
    expect(()=>acceptFeatureUnification({features:[feature('F1',['S1']),feature('F2',['S3'])],candidateMappings},candidates,sources)).toThrow('遗漏候选来源');
  });
  it('统一检查可报告有明确候选和来源的分类问题',()=>{
    const issues=[{candidateIds:['C1','C2'],sourceUnitIds:['S1','S2'],detail:'文档说明被误判业务功能'}];
    expect(acceptCandidateClassificationIssues(issues,[feature('C1',['S1']),feature('C2',['S2'])],sources)).toEqual(issues);
  });
  it('分类问题拒绝空说明、空或非法引用及候选范围外来源',()=>{
    const candidates=[feature('C1',['S1'])],issue={candidateIds:['C1'],sourceUnitIds:['S1'],detail:'需重分类'};
    for(const patch of [{candidateIds:[]},{sourceUnitIds:[]},{detail:''},{candidateIds:['BAD']},{sourceUnitIds:['BAD']},{sourceUnitIds:['S2']}])expect(()=>acceptCandidateClassificationIssues([{...issue,...patch}],candidates,sources)).toThrow();
    expect(()=>acceptCandidateClassificationIssues({},candidates,sources)).toThrow('必须是数组');
  });
  it('允许显式合并与拆分并保留来源',()=>{
    const candidates=[feature('C1',['S1','S2']),feature('C2',['S3'])];
    const result=acceptFeatureUnification({features:[feature('F1',['S1']),feature('F2',['S2','S3'])],candidateMappings:[{candidateId:'C1',featureIds:['F1','F2']},{candidateId:'C2',featureIds:['F2']}]},candidates,sources);
    expect(result.map(item=>item.sourceUnitIds)).toEqual([['S1'],['S2','S3']]);
  });
  it('拒绝遗漏或重复候选映射、未被映射功能及无效引用',()=>{
    const candidates=[feature('C1',['S1'])],features=[feature('F1',['S1'])];
    const mapping={candidateId:'C1',featureIds:['F1']};
    expect(()=>acceptFeatureUnification({features,candidateMappings:[]},candidates,sources)).toThrow('遗漏候选');
    expect(()=>acceptFeatureUnification({features,candidateMappings:[mapping,mapping]},candidates,sources)).toThrow('重复映射');
    expect(()=>acceptFeatureUnification({features:[...features,feature('F2',['S2'])],candidateMappings:[mapping]},candidates,sources)).toThrow('没有候选映射');
    expect(()=>acceptFeatureUnification({features,candidateMappings:[{...mapping,featureIds:['BAD']}]},candidates,sources)).toThrow('不存在的 ID');
  });
  it('拒绝漏掉候选来源以及从未映射候选借用来源',()=>{
    expect(()=>acceptFeatureUnification({features:[feature('F1',['S1'])],candidateMappings:[{candidateId:'C1',featureIds:['F1']}]},[feature('C1',['S1','S2'])],sources)).toThrow('遗漏候选来源');
    expect(()=>acceptFeatureUnification({features:[feature('F1',['S1','S2']),feature('F2',['S2'])],candidateMappings:[{candidateId:'C1',featureIds:['F1']},{candidateId:'C2',featureIds:['F2']}]},[feature('C1',['S1']),feature('C2',['S2'])],sources)).toThrow('映射候选之外');
  });
  it('待澄清事项不能伪装成功能，跨功能约束类型保留',()=>{
    expect(()=>acceptDirectFeatures([{...feature('F1',['S1']),kind:'clarification'}],sources)).toThrow('待澄清事项不能作为功能');
    expect(acceptDirectFeatures([{...feature('F1',['S1']),kind:'constraint'}],sources)[0].kind).toBe('constraint');
  });
  it('跨功能约束显式保留适用关系，缺省时不推断',()=>{
    const values=[feature('F1',['S1']),{...feature('C1',['S2']),kind:'constraint',appliesToFeatureIds:['F1']},{...feature('C2',['S3']),kind:'constraint'}];
    const result=acceptDirectFeatures(values,sources);expect(result[1].appliesToFeatureIds).toEqual(['F1']);expect(result[2].appliesToFeatureIds).toBeUndefined();
    const batch=acceptDirectFeatureBatch(values,sources.map(u=>({sourceUnitId:u.id,contentRole:'requirement',reason:'明确要求',featureIds:[]})),sources);expect(batch.features[1].appliesToFeatureIds).toEqual(['F1']);
  });
  it('适用关系拒绝不存在的功能、自引用及普通功能声明',()=>{
    expect(()=>acceptDirectFeatures([{...feature('C1',['S1']),kind:'constraint',appliesToFeatureIds:['BAD']}],sources)).toThrow('不存在的 ID');
    expect(()=>acceptDirectFeatures([{...feature('C1',['S1']),kind:'constraint',appliesToFeatureIds:['C1']}],sources)).toThrow('禁止自引用');
    expect(()=>acceptDirectFeatures([{...feature('F1',['S1']),appliesToFeatureIds:['F2']},feature('F2',['S2'])],sources)).toThrow('仅 constraint');
    expect(()=>graph([{...feature('F1',['S1'],['R1']),kind:'constraint',appliesToFeatureIds:['DELETED']}])).toThrow('不存在的 ID');
    expect(()=>graph([{...feature('F1',['S1'],['R1']),kind:'constraint',appliesToFeatureIds:['F1']}])).toThrow('禁止自引用');
  });
  it('统一输出的约束关系必须引用统一后的功能编号',()=>{
    const candidates=[feature('OLD',['S1']),{...feature('C',['S2']),kind:'constraint' as const}];
    const payload={features:[feature('NEW',['S1']),{...feature('NC',['S2']),kind:'constraint',appliesToFeatureIds:['OLD']}],candidateMappings:[{candidateId:'OLD',featureIds:['NEW']},{candidateId:'C',featureIds:['NC']}]};
    expect(()=>acceptFeatureUnification(payload,candidates,sources)).toThrow('不存在的 ID');payload.features[1].appliesToFeatureIds=['NEW'];expect(acceptFeatureUnification(payload,candidates,sources)[1].appliesToFeatureIds).toEqual(['NEW']);
  });
  it('拒绝全局重复编号、悬空引用、孤儿需求和多主归属',()=>{
    expect(()=>graph([feature('F1',['S1'],['R1'])],[requirement,{...requirement}])).toThrow('重复 ID');
    expect(()=>graph([feature('F1',['S1'],['BAD'])])).toThrow('不存在的 ID');
    expect(()=>graph([feature('F1',['S1'])])).toThrow('没有一致的主所属功能');
    expect(()=>graph([feature('F1',['S1'],['R1']),feature('F2',['S1'],['R1'])])).toThrow('仅有一个主所属');
    expect(()=>graph([feature('R1',['S1'],['R1'])])).toThrow('重复 ID');
  });
  it('每个原文单元必须有且仅有合法处置',()=>{
    const features=[feature('F1',['S1'],['R1'])];
    expect(()=>graph(features,[requirement],[...dispositions,dispositions[0]])).toThrow('重复 ID');
    expect(()=>graph(features,[requirement],dispositions.slice(1))).toThrow('未分类原文单元');
    expect(()=>graph(features,[requirement],[...dispositions,{...dispositions[0],sourceUnitId:'BAD'}])).toThrow('不存在的 ID');
  });
  it('需求与待澄清来源都进入覆盖检查，澄清无需伪造功能',()=>{
    const ds=dispositions.map(item=>item.sourceUnitId==='S2'?{...item,kind:'clarification' as const}:item);
    const features=[feature('F1',['S1'],['R1'])];
    expect(graph(features,[requirement],ds).uncovered.map(item=>item.sourceUnitId)).toEqual(['S2']);
    expect(validateDirectGraph(sources,ds,features,[requirement],[{id:'Q1',question:'待确认',reason:'未明确',affectedIds:['S2'],state:'open'}]).uncovered).toEqual([]);
    expect(validateDirectGraph(sources,dispositions,features,[requirement],[{id:'Q1',question:'待确认',reason:'未明确',affectedIds:['R1'],state:'open'}]).uncovered).toEqual([]);
  });
  it('简短需求拒绝旧规格书字段和补件来源',()=>{
    expect(acceptDirectDetails([requirement],[],sources).requirements[0]).toEqual(requirement);
    for(const field of ['behavior','conditions','constraints','explicitAcceptanceConditions','evidenceBindings'])expect(()=>acceptDirectDetails([{...requirement,[field]:[]}],[],sources)).toThrow('旧规格书');
    expect(()=>acceptDirectDetails([requirement],[],sources.map(s=>({...s,sourceRole:'supplement'})))).toThrow('主 PRD');
    expect(()=>acceptDirectDetails([{...requirement,sourceRefs:[]}],[],sources)).toThrow('不得为空');
  });
  it('明确要求的来源处置会确定性补入其关联候选',()=>{
    const batch=acceptDirectFeatureBatch([{...feature('F1',['S1']),sourceUnitIds:['S1']}],[{sourceUnitId:'S1',contentRole:'requirement',reason:'正文要求',featureIds:['F1']},{sourceUnitId:'S2',contentRole:'requirement',reason:'标题要求',featureIds:['F1']},{sourceUnitId:'S3',contentRole:'context',reason:'文档结构',featureIds:['F1']}],sources);
    expect(batch.features[0].sourceUnitIds).toEqual(['S1','S2']);
    expect(batch.features[0].sourceRefs).toEqual([{sourceUnitId:'S1'},{sourceUnitId:'S2'}]);
  });
  it('章节标题只用于结构定位和功能命名，不进入需求覆盖门禁',()=>{
    const heading={...sources[1],kind:'heading' as const,excerpt:'5.4 数据集表格'};
    const batch=acceptDirectFeatureBatch([feature('F1',['S1'])],[{sourceUnitId:'S1',contentRole:'requirement',reason:'正文要求',featureIds:['F1']},{sourceUnitId:'S2',contentRole:'requirement',reason:'标题要求',featureIds:['F1']}],[sources[0],heading]);
    expect(batch.dispositions[1]).toMatchObject({sourceUnitId:'S2',kind:'context',featureIds:['F1']});
    expect(batch.features[0].sourceUnitIds).toEqual(['S1']);
    expect(validateDirectGraph([sources[0],heading],batch.dispositions,[{...batch.features[0],requirementIds:['R1']}],[requirement],[]).uncovered).toEqual([]);
  });
  it('功能引用的连续文字必须在指定原文中唯一并转换为稳定选区',()=>{
    const parsed=acceptDirectFeatures([{id:'LOCAL-F',name:'字段校验',kind:'function',sourceRefs:[{sourceUnitId:'S1',quote:'字段 X'}],state:'draft'}],sources);
    expect(parsed[0].name).toBe('字段校验');expect(parsed[0].sourceUnitIds).toEqual(['S1']);expect(parsed[0].sourceRefs).toEqual([{sourceUnitId:'S1',start:0,end:4}]);
    expect(()=>acceptDirectFeatures([{id:'LOCAL-F',name:'字段校验',sourceRefs:[{sourceUnitId:'S1',quote:'不存在'}],state:'draft'}],sources)).toThrow('不在指定原文');
    const repeated=[{...sources[0],excerpt:'字段 X 与字段 X'}];expect(()=>acceptDirectFeatures([{id:'LOCAL-F',name:'字段校验',sourceRefs:[{sourceUnitId:'S1',quote:'字段 X'}],state:'draft'}],repeated)).toThrow('不唯一');
  });
  it('显式业务关系保留真实两端与原文引用',()=>{
    const second={...requirement,id:'R2'};
    expect(acceptRequirementRelations([{sourceRequirementId:'R1',targetRequirementId:'R2',kind:'affects',sourceRefs:[{sourceUnitId:'S1'}]}],sources,[requirement,second])).toHaveLength(1);
    expect(()=>acceptRequirementRelations([{sourceRequirementId:'R1',targetRequirementId:'R1',kind:'depends-on',sourceRefs:[{sourceUnitId:'S1'}]}],sources,[requirement])).toThrow('禁止自引用');
  });
});
