import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {materializeEvidenceSelections} from '../electron/source-evidence.js';
import { nodeContracts, schemaToJson, detailOutputSchema } from '../electron/model-output-schemas.js';

const requirement={id:'LOCAL-R1',text:'允许申请',evidenceIds:['E1']};
const question={id:'Q1',question:'如何处理？',reason:'没有说明',knownFacts:'可以申请',unresolvedPoint:'异常处理',impact:'影响申请',levelReason:'需业务决定',affectedIds:['S1'],evidenceIds:['E1']};
describe('类型化节点领域契约',()=>{
 it('所有节点均有输入、候选、正式结果契约，空输入不能通过',()=>{
  expect(Object.keys(nodeContracts)).toHaveLength(13);
  for(const node of Object.values(nodeContracts)){
   expect(node.input.safeParse({}).success).toBe(false);
   expect(node.proposal.safeParse(null).success).toBe(false);
   expect(node.result.safeParse(null).success).toBe(false);
   expect(schemaToJson(node.proposal)).toHaveProperty('$schema');
  }
 });
 it('非空字段证据与可空的显式验收目录分别约束',()=>{
  expect(nodeContracts.details.proposal.safeParse({requirements:[requirement],clarifications:[]}).success).toBe(true);
  expect(nodeContracts.details.proposal.safeParse({requirements:[{...requirement,evidenceIds:[]}],clarifications:[]}).success).toBe(false);
  expect(nodeContracts.details.proposal.safeParse({requirements:[{...requirement,state:'draft'}],clarifications:[]}).success).toBe(false);
  expect(nodeContracts.details.proposal.safeParse({requirements:[{...requirement,featureId:'ignored'}],clarifications:[]}).success).toBe(false);
  expect(nodeContracts.details.input.safeParse({feature:{id:'F1',name:'申请',kind:'function'},applicableConstraints:[],sourceUnits:[]}).success).toBe(false);
  expect(nodeContracts.details.proposal.safeParse({requirements:[{...requirement,conditions:[{text:'   ',evidenceIds:['E1']}]}],clarifications:[]}).success).toBe(false);
 });
 it('澄清按级别条件必填，不强制无关字段或内部状态',()=>{
  const parse=(q:object)=>nodeContracts.details.proposal.safeParse({requirements:[],clarifications:[q]}).success;
  expect(parse({...question,level:'ignorable'})).toBe(true);
  expect(parse({...question,level:'suggestion'})).toBe(false);
  expect(parse({...question,level:'suggestion',defaultResolution:'沿用既有流程'})).toBe(true);
  expect(parse({...question,level:'blocking'})).toBe(false);
  expect(parse({...question,level:'blocking',resolutionProposal:{recommendation:'保持申请当前状态并允许用户重新提交',rationale:'原文允许申请',impact:'不丢失申请',confirmation:'确认可重新提交',alternatives:[],evidenceIds:['E1']}})).toBe(true);
  expect(parse({...question,level:'ignorable',state:'open'})).toBe(false);
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
  const parse=(action:object)=>nodeContracts.adjustmentGenerate.proposal.safeParse({requirementActions:[action],clarificationActions:[],relationActions:[]}).success;
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
