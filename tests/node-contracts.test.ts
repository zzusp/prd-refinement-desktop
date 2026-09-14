import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {materializeEvidenceSelections} from '../electron/source-evidence.js';
import { nodeContracts, schemaToJson, detailOutputSchema } from '../electron/model-output-schemas.js';

const requirement={id:'LOCAL-R1',text:'允许申请',evidenceIds:['E1']};
const question={id:'Q1',question:'如何处理？',reason:'没有说明',knownFacts:'可以申请',unresolvedPoint:'异常处理',impact:'影响申请',levelReason:'需业务决定',affectedIds:['S1'],evidenceIds:['E1']};
describe('类型化节点领域契约',()=>{
 it('所有节点均有输入、候选、正式结果契约，空输入不能通过',()=>{
  expect(Object.keys(nodeContracts)).toHaveLength(12);
  for(const node of Object.values(nodeContracts)){
   expect(node.input.safeParse({}).success).toBe(false);
   expect(node.proposal.safeParse(null).success).toBe(false);
   expect(node.result.safeParse(null).success).toBe(false);
   expect(schemaToJson(node.proposal)).toHaveProperty('$schema');
  }
 });
 it('非空字段证据与可空的显式验收目录分别约束',()=>{
  expect(nodeContracts.details.proposal.safeParse({requirements:[requirement]}).success).toBe(true);
  expect(nodeContracts.details.proposal.safeParse({requirements:[{...requirement,evidenceIds:[]}]}).success).toBe(false);
  expect(nodeContracts.details.proposal.safeParse({requirements:[{...requirement,state:'draft'}]}).success).toBe(false);
  expect(nodeContracts.details.proposal.safeParse({requirements:[{...requirement,featureId:'ignored'}]}).success).toBe(false);
  expect(nodeContracts.details.input.safeParse({feature:{id:'F1',name:'申请',kind:'function'},applicableConstraints:[],sourceUnits:[]}).success).toBe(false);
  expect(nodeContracts.details.proposal.safeParse({requirements:[{...requirement,conditions:[{text:'   ',evidenceIds:['E1']}]}]}).success).toBe(false);
 });
 it('所有生成链拒绝问题、建议和澄清，即使字段为空',()=>{
  expect(nodeContracts.details.proposal.safeParse({requirements:[requirement]}).success).toBe(true);
  for(const field of ['clarifications','pending','resolutionProposal','claims','conditions'])expect(nodeContracts.details.proposal.safeParse({requirements:[],[field]:[]}).success).toBe(false);
  for(const level of ['ignorable','suggestion','blocking'])expect(nodeContracts.details.proposal.safeParse({requirements:[],clarifications:[{...question,level}]}).success).toBe(false);
  expect(nodeContracts.repair.proposal.safeParse({requirements:[],deleteRequirementIds:[]}).success).toBe(true);
  expect(nodeContracts.repair.proposal.safeParse({requirements:[],deleteRequirementIds:[],deleteClarificationIds:[]}).success).toBe(false);
  expect(nodeContracts.adjustmentGenerate.proposal.safeParse({requirementActions:[],relationActions:[],clarificationActions:[]}).success).toBe(false);
  expect(nodeContracts.adjustmentReview.proposal.safeParse({passed:true,issues:[],clarificationResolutions:[]}).success).toBe(false);
  expect(nodeContracts.adjustmentParse.proposal.safeParse({operations:[],pending:[]}).success).toBe(false);
  const issue={id:'A1',direction:'forward',type:'缺口',sourceUnitIds:['S1'],affectedIds:['R1'],detail:'原文未明确',owner:'requirement-detail',category:'source-ambiguity'};
  expect(nodeContracts.audit.proposal.safeParse({issues:[issue],relations:[]}).success).toBe(false);
  expect(nodeContracts.repairReview.proposal.safeParse({originalIssueResults:[],introducedIssues:[issue],discoveredIssues:[]}).success).toBe(false);
  const input={feature:{id:'F1',name:'申请',kind:'function'},applicableConstraints:[],sourceUnits:[{id:'S1',label:'申请',kind:'paragraph',location:'第1段'}],evidenceCatalog:[{id:'E1',sourceUnitId:'S1',start:0,end:2,text:'申请'}]};
  expect(nodeContracts.details.input.safeParse(input).success).toBe(true);
  expect(nodeContracts.details.input.safeParse({...input,clarifications:[]}).success).toBe(false);
  expect(nodeContracts.details.input.safeParse({...input,context:{resolutionProposal:{recommendation:'猜测'}}}).success).toBe(false);
  const accepted={id:'R1',featureId:'F1',text:'只有草稿可撤回，已提交的申请不得撤回',sourceRefs:[{sourceUnitId:'S1'}],state:'draft'};
  expect(nodeContracts.details.result.safeParse({requirements:[accepted],clarifications:[]}).success).toBe(true);
  expect(nodeContracts.details.result.safeParse({requirements:[accepted],clarifications:[question]}).success).toBe(false);
 });
 it('功能统一是互斥结果，不能半提交或混用分支',()=>{
  expect(nodeContracts.unify.proposal.safeParse({neededSourceUnitIds:['S1']}).success).toBe(true);
  expect(nodeContracts.unify.proposal.safeParse({neededSourceUnitIds:[]}).success).toBe(false);
  expect(nodeContracts.unify.proposal.safeParse({neededSourceUnitIds:['S1'],features:[],candidateMappings:[]}).success).toBe(false);
  expect(nodeContracts.unify.proposal.safeParse({features:[]}).success).toBe(false);
 });
 it('输入范围决定须给范围，普通功能不允许声明约束目标',()=>{
  expect(nodeContracts.inputInterpretation.proposal.safeParse({entries:[{sourceUnitId:'U1',kind:'scope-decision',summary:'排除'}]}).success).toBe(false);
  expect(nodeContracts.candidates.proposal.safeParse({features:[{id:'F1',name:'申请',kind:'function',appliesToFeatureIds:['F2'],evidenceIds:['E1']}],sourceDispositions:[]}).success).toBe(false);
 });
 it('调整动作按操作条件要求载荷，删除不得带候选需求',()=>{
  const parse=(action:object)=>nodeContracts.adjustmentGenerate.proposal.safeParse({requirementActions:[action],relationActions:[]}).success;
  expect(parse({action:'create',requirement})).toBe(true);
  expect(parse({action:'update',requirement})).toBe(false);
  expect(parse({action:'delete',targetId:'R1'})).toBe(true);
  expect(parse({action:'delete',targetId:'R1',requirement})).toBe(false);
 });
 it('传输 Schema 从同一候选定义生成，证据 minItems=1',()=>{
  expect(detailOutputSchema).toEqual(schemaToJson(nodeContracts.details.proposal));
  const schema=detailOutputSchema as any;
  const item=schema.properties.requirements.items;
  expect(item.properties.evidenceIds.minItems).toBe(1);
  expect(item.properties).not.toHaveProperty('explicitAcceptanceEvidenceIds');
 });
 it('仅对可证明互斥的判别分支将 oneOf 转为等价 anyOf',()=>{
  const schema=schemaToJson(z.discriminatedUnion('tag',[z.strictObject({tag:z.literal('a'),value:z.string()}),z.strictObject({tag:z.literal('b'),value:z.number()})]));
  expect(schema.oneOf).toBeUndefined();expect(schema.anyOf).toHaveLength(2);
  expect(JSON.stringify(schemaToJson(nodeContracts.adjustmentGenerate.proposal))).not.toContain('"oneOf"');
 });
 it('optional 使用精确的有无字段分支，不变为必填 null',()=>{
  const schema=schemaToJson(z.strictObject({id:z.string(),featureId:z.string().optional()})) as any;
  expect(schema.anyOf).toHaveLength(2);
  expect(schema.anyOf[0].properties).toEqual({id:{type:'string'}});
  expect(schema.anyOf[0].required).toEqual(['id']);
  expect(schema.anyOf[1].required).toEqual(['id','featureId']);
  expect(schema.anyOf.every((branch:any)=>branch.additionalProperties===false)).toBe(true);
 });
 it('固定键分配数组物化为来源映射，重复目标拒绝而非覆盖',()=>{
  const catalog=[{id:'E1',sourceUnitId:'S1',start:0,end:2,text:'原文'}];
  const allocation={featureId:'F1',evidenceIds:['E1']};
  expect(materializeEvidenceSelections({allocations:[allocation]},catalog)).toEqual({sourceRefsByFeature:{F1:[{sourceUnitId:'S1',start:0,end:2}]}});
  expect(()=>materializeEvidenceSelections({allocations:[allocation,allocation]},catalog)).toThrow('重复');
  expect(()=>materializeEvidenceSelections({allocations:[allocation],sourceRefsByFeature:{}},catalog)).toThrow('混用');
  expect(JSON.stringify(schemaToJson(nodeContracts.unify.proposal))).not.toContain('propertyNames');
 });
});
