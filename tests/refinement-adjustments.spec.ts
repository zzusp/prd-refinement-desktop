import { describe, expect, it } from "vitest";
import {
  RefinementAdjustmentEngine,
  type AdjustmentModelAdapter,
} from "../electron/refinement-adjustments";
import type { PrdProject, SourceUnit } from "../src/types";
import type { AnalysisRuntime } from "../electron/runtime";
import { CandidateValidationError, executeNode } from "../electron/node-executor";
import { DomainValidationError } from "../electron/node-validation";
import { DetailEvidenceValidationError } from "../electron/source-evidence";
import { nodeContracts, schemaToJson } from "../electron/model-output-schemas";

const unit = (id: string, text: string): SourceUnit => ({
  id,
  label: id,
  kind: "paragraph",
  excerpt: text,
  location: id,
  status: "processed",
});
const detail = (
  id: string,
  title: string,
  behavior: string,
  sourceUnitId: string,
) => ({
  id,
  featureId: id==='R1'?'F1':id==='R2'?'F2':'F3',
  text: behavior,
  sourceRefs: [{ sourceUnitId,start:0,end:behavior.length+1 }],
  state: "reviewed" as const,
});
const project = (): PrdProject => ({
  id: "P",
  name: "PRD",
  sourceName: "prd.md",
  sourceHash: "H",
  revision: 1,
  importedAt: "now",
  rawText: "",
  stage: "review",
  sourceUnits: [
    unit("S1", "用户可以提交订单。"),
    unit("S2", "用户可以取消订单。"),
    unit("S3", "用户可以查询订单。"),
  ],
  features: [
    {
      id: "F1",
      kind: "function",
      name: "提交订单",
      sourceUnitIds: ["S1"],
      sourceRefs: [{ sourceUnitId: "S1" }],
      ruleIds: [],
      requirementIds: ["R1"],
      state: "reviewed",
    },
    {
      id: "F2",
      kind: "function",
      name: "取消订单",
      sourceUnitIds: ["S2"],
      sourceRefs: [{ sourceUnitId: "S2" }],
      ruleIds: [],
      requirementIds: ["R2"],
      state: "reviewed",
    },
    {
      id: "F3",
      kind: "function",
      name: "查询订单",
      sourceUnitIds: ["S3"],
      sourceRefs: [{ sourceUnitId: "S3" }],
      ruleIds: [],
      requirementIds: ["R3"],
      state: "reviewed",
    },
  ],
  requirements: [
    detail("R1", "提交", "用户可以提交订单", "S1"),
    detail("R2", "取消", "用户可以取消订单", "S2"),
    detail("R3", "查询", "用户可以查询订单", "S3"),
  ],
  clarifications: [],
});
const req = (
  input: any,
  targetId: string,
  behavior: string,
  evidenceId?: string,
) => {
  const chosen = evidenceId
    ? input.evidenceCatalog.find((x: any) => x.sourceUnitId === evidenceId)
    : input.evidenceCatalog.find((x: any) => x.text.includes(behavior));
  return {
    id: targetId,
    text: behavior,
    evidenceIds: [chosen.id],
  };
};
const empty = () => ({
  requirementActions: [],
  relationActions: [],
});
const request = (feedback: string) => ({
  baseTaskId: "T",
  baseVersion: 1,
  feedback,
});
const adapter = (
  fn: (call: Parameters<AdjustmentModelAdapter["generate"]>[0]) => unknown,
): AdjustmentModelAdapter => ({ async generate(call) {
  const contract=nodeContracts[call.operation];
  return executeNode({...contract,id:call.operation,parameters:schemaToJson(contract.proposal),instructions:call.instruction,accept:value=>{
    try{return call.accept(value);}catch(error){
      if(error instanceof DomainValidationError||error instanceof DetailEvidenceValidationError)throw new CandidateValidationError(error.issues);
      throw error;
    }
  }},{workItemId:call.operation,executionId:"test",input:call.input,configuration:{},receipts:{},save:async()=>{},assert(){},runtime:async()=>({executeOperation:async()=>({completion:"completed",value:fn(call)})}) as unknown as AnalysisRuntime});
}});


const op=(quote="精简提交",kind="organization",featureIds=["F1"],id="O1")=>({id,quote,kind,instruction:quote,featureIds});
describe("仅输出清单的任务级调整",()=>{
  it("组织调整通过完整节点契约复核，保留出处且范围外不变",async()=>{
    const value=project(),calls:string[]=[],inputs:unknown[]=[];
    const engine=new RefinementAdjustmentEngine(adapter(call=>{
      calls.push(call.operation);inputs.push(call.input);
      if(call.operation==="adjustmentParse")return {operations:[op()]};
      if(call.operation==="adjustmentReview")return {passed:true,issues:[]};
      const requirement=req(call.input,"R1","用户可以提交订单");requirement.text="支持提交订单";
      return {...empty(),requirementActions:[{action:"update",targetId:"R1",requirement}]};
    }));
    const result=await engine.run({taskId:"T",version:1,project:value},request("精简提交"));
    expect(result.status,result.error).toBe("completed");expect(calls).toEqual(["adjustmentParse","adjustmentGenerate","adjustmentReview"]);
    expect(result.project.requirements[0]).toMatchObject({id:"R1",text:"支持提交订单",sourceRefs:[{sourceUnitId:"S1",start:0,end:9}]});
    expect(result.project.requirements.slice(1)).toEqual(value.requirements.slice(1));expect(result.project.clarifications).toEqual([]);
    for(const input of inputs)expect(JSON.stringify(input)).not.toMatch(/"(?:clarifications|resolutionProposal|beforeClarifications)"/);
  });
  it("新增或替换业务规则只记录未执行，不扩写清单",async()=>{
    const value=project(),calls:string[]=[];
    const engine=new RefinementAdjustmentEngine(adapter(call=>{calls.push(call.operation);return {operations:[op("允许重复提交","business-fact"),op("取消订单改为删除","replace-fact",["F2"],"O2")]};}));
    const result=await engine.run({taskId:"T",version:1,project:value},request("允许重复提交；取消订单改为删除"));
    expect(calls).toEqual(["adjustmentParse"]);expect(result.results.map(x=>x.status)).toEqual(["deferred","deferred"]);
    expect(result.project.requirements).toEqual(value.requirements);expect(result.project.sourceUnits).toEqual(value.sourceUnits);
    expect(result.project.clarifications).toEqual([]);expect(result.userEvidence.every(x=>!x.businessFact)).toBe(true);
  });
  it("模型返回澄清动作被结构契约拒绝，原项目保持不变",async()=>{
    const value=project(),engine=new RefinementAdjustmentEngine(adapter(call=>call.operation==="adjustmentParse"?{operations:[op()]}:{...empty(),clarificationActions:[]}));
    const result=await engine.run({taskId:"T",version:1,project:value},request("精简提交"));
    expect(result.status).toBe("failed");expect(result.error).toContain("clarificationActions");expect(result.project.requirements).toEqual(value.requirements);
  });
  it("旧建议、澄清引用与旧版结果在调用模型前拒绝",async()=>{
    let calls=0;const engine=new RefinementAdjustmentEngine(adapter(()=>{calls++;throw Error("不应调用模型");})),value=project();
    for(const patch of [{acceptedProposalIds:["Q1"]},{acceptedProposals:[{clarificationId:"Q1",baseRecommendation:"拒绝重复",finalText:"拒绝重复"}]},{references:[{kind:"clarification" as const,id:"Q1"}]}])await expect(engine.run({taskId:"T",version:1,project:value},{...request("精简提交"),...patch})).rejects.toThrow("仅支持功能与需求");
    value.clarifications=[{id:"Q1",question:"旧问题",reason:"历史记录",affectedIds:["R1"],state:"open"}];
    await expect(engine.run({taskId:"T",version:1,project:value},request("精简提交"))).rejects.toThrow("旧版结果仅供查看");expect(calls).toBe(0);
  });
  it("复核失败进入独立修正并再复核，仍失败时回滚",async()=>{
    for(const passes of [true,false]){
      const value=project(),calls:string[]=[];let reviews=0;
      const engine=new RefinementAdjustmentEngine(adapter(call=>{
        calls.push(call.operation);
        if(call.operation==="adjustmentParse")return {operations:[op()]};
        if(call.operation==="adjustmentReview"){const passed=++reviews>1&&passes;return {passed,issues:passed?[]:["丢失必要限定"]};}
        const input=call.operation==="adjustmentRepair"?(call.input as any).originalInput:call.input;
        return {...empty(),requirementActions:[{action:"update",targetId:"R1",requirement:req(input,"R1","用户可以提交订单")}]};
      }));
      const result=await engine.run({taskId:"T",version:1,project:value},request("精简提交"));
      expect(calls).toEqual(["adjustmentParse","adjustmentGenerate","adjustmentReview","adjustmentRepair","adjustmentReview"]);
      expect(result.status).toBe(passes?"completed":"failed");if(!passes)expect(result.project.requirements).toEqual(value.requirements);
    }
  });
  it("空证据、模型内部状态与越界改写均无法提交",async()=>{
    for(const invalid of ["evidence","state","target"]){
      const value=project(),engine=new RefinementAdjustmentEngine(adapter(call=>{
        if(call.operation==="adjustmentParse")return {operations:[op()]};
        const requirement:any=req(call.input,"R1","用户可以提交订单");
        if(invalid==="evidence")requirement.evidenceIds=[];if(invalid==="state")requirement.state="reviewed";
        return {...empty(),requirementActions:[{action:"update",targetId:invalid==="target"?"R2":"R1",requirement}]};
      }));
      const result=await engine.run({taskId:"T",version:1,project:value},request("精简提交"));
      expect(result.status).toBe("failed");expect(result.project.requirements).toEqual(value.requirements);
    }
  });
  it("关系接受有效来源和两端，拒绝自引用、未知两端和未知证据",async()=>{
    for(const invalid of ["none","self","target","evidence"]){
      const value=project(),engine=new RefinementAdjustmentEngine(adapter(call=>{
        if(call.operation==="adjustmentParse")return {operations:[op()]};
        if(call.operation==="adjustmentReview")return {passed:true,issues:[]};
        return {...empty(),relationActions:[{action:"create",relation:{id:"LOCAL-REL",sourceRequirementId:"R1",targetRequirementId:invalid==="self"?"R1":invalid==="target"?"MISSING":"R2",kind:"affects",evidenceIds:invalid==="evidence"?["MISSING"]:req(call.input,"R1","用户可以提交订单").evidenceIds}}]};
      }));
      const result=await engine.run({taskId:"T",version:1,project:value},request("精简提交"));
      expect(result.status,result.error).toBe(invalid==="none"?"completed":"failed");
      if(invalid==="none")expect(result.project.relations?.[0]).toMatchObject({sourceRequirementId:"R1",targetRequirementId:"R2",sourceRefs:[{sourceUnitId:"S1",start:0,end:9}]});
      else expect(result.project.relations).toBeUndefined();
    }
  });
  it("无定位不猜测目标，同一功能多条意见只生成一次",async()=>{
    for(const featureIds of [[],["F1"]]){
      let generated=0;const engine=new RefinementAdjustmentEngine(adapter(call=>{
        if(call.operation==="adjustmentParse")return {operations:[op("合并描述","organization",featureIds),op("精简条目","organization",featureIds,"O2")]};
        if(call.operation==="adjustmentReview")return {passed:true,issues:[]};generated++;return empty();
      }));
      const result=await engine.run({taskId:"T",version:1,project:project()},request("合并描述；精简条目"));
      expect(generated).toBe(featureIds.length?1:0);expect(result.status).toBe(featureIds.length?"completed":"failed");
    }
  });
});
