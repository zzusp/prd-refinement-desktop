import { describe, expect, it } from 'vitest';
import { acceptAuditIssues, acceptDetails, acceptRules, validateGraph } from '../electron/domain';
import { selectRuleRepairBatch } from '../electron/audit-repair';
import type { Feature, RequirementDetail, RequirementRule, SourceUnit } from '../src/types';

const sources:SourceUnit[]=[{id:'S-001',label:'要求',kind:'paragraph',excerpt:'字段 X 必填',location:'第 1 行',status:'processed'}];
const rules:RequirementRule[]=[{id:'RL-0001',statement:'字段 X 必填',sourceUnitIds:['S-001'],conditions:[],kind:'data',status:'explicit'}];
const requirements:RequirementDetail[]=[{id:'R-0001',featureId:'F-001',text:'字段 X 必填',sourceRefs:[{sourceUnitId:'S-001'}],state:'reviewed'}];
const features:Feature[]=[{id:'F-001',name:'提交校验',goal:'阻止缺失必要数据',sourceUnitIds:['S-001'],ruleIds:['RL-0001'],requirementIds:['R-0001'],state:'reviewed'}];

describe('领域候选验收',()=>{
  it('规则定点返工只选择小型来源连通簇',()=>{
    const issue=(id:string,sources:string[])=>({id,direction:'forward',type:'遗漏',category:'rule-extraction' as const,sourceUnitIds:sources,affectedIds:['RL-0001'],detail:id});
    const batch=selectRuleRepairBatch([issue('wide',Array.from({length:13},(_,i)=>`S-${i}`)),issue('a',['S-1']),issue('b',['S-1','S-2']),issue('c',['S-9'])]);
    expect(batch.map(item=>item.id)).toEqual(['a','b']);
  });
  it('旧规格书字段不能混入正式需求',()=>{expect(()=>acceptDetails([{...requirements[0],behavior:'扩写'}],[],rules,sources)).toThrow('旧规格书')});
  it('模型不得自动标记问题已解决',()=>{expect(()=>acceptDetails(requirements,[{id:'q',question:'?',reason:'?',affectedIds:['R-0001'],state:'resolved'}],rules,sources)).toThrow('不得自动解决')});
  it('拒绝不存在的来源引用',()=>expect(()=>acceptRules([{...rules[0],id:'LOCAL',sourceUnitIds:['S-404']}],sources)).toThrow('不存在的 ID'));
  it('接受简短需求且保留原文引用',()=>expect(acceptDetails(requirements,[],rules,sources).requirements).toEqual(requirements));
  it('拒绝悬空问题引用',()=>expect(()=>validateGraph(sources,rules,features,requirements,[{id:'Q-001',question:'?',reason:'?',affectedIds:['TEMP-404'],state:'open'}])).toThrow('不存在的 ID'));
  it('没有中间规则时仍可校验直接需求',()=>expect(validateGraph(sources,[],features,requirements,[]).unimplemented).toEqual([]));
  it('unknown 规则进入待澄清而不强制生成实现内容',()=>{const unknown:RequirementRule={...rules[0],id:'RL-0002',statement:'域名取值未明确',status:'unknown',kind:'unknown'};const graph=validateGraph(sources,[...rules,unknown],[{...features[0],ruleIds:['RL-0001','RL-0002']}],requirements,[]);expect(graph.unimplemented).toEqual([]);expect(graph.unknown).toEqual([unknown])});
  it('拒绝审计结果中的悬空来源和影响对象',()=>expect(()=>acceptAuditIssues([{id:'LOCAL-A',direction:'forward',type:'遗漏',sourceUnitIds:['S-404'],affectedIds:['R-404'],detail:'缺少规则'}],sources,rules,features,requirements,[])).toThrow('不存在的 ID'));
});
