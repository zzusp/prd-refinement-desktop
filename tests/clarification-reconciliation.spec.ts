import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {reconcileClarifications,type ReconciliationContext} from '../electron/clarification-reconciliation';
import {reconcileRelations} from '../electron/clarification-relations';
import {measurePrompt} from '../electron/prompt-budget';
import {evidencePromptInput,materializeEvidenceSelections} from '../electron/source-evidence';
import type {Clarification,ClarificationAction,PrdProject,SourceUnit} from '../src/types';

const question=(id:string):Clarification=>({id,question:'风险分数为90的订单是否需要二次审核？',knownFacts:'已经得到风险分数',unresolvedPoint:'是否需要二次审核',reason:'待核对规则',affectedIds:[],state:'open'});
const source=(id:string,excerpt:string):SourceUnit=>({id,label:id,kind:'paragraph',excerpt,location:id,status:'processed'});
const project=(questions:Clarification[],units:SourceUnit[]=[]):PrdProject=>({id:'P',name:'test',sourceName:'test',sourceHash:'frozen',revision:1,importedAt:'2026-09-12',rawText:'',stage:'refining',sourceUnits:units,features:[],requirements:[],clarifications:questions});
type Call={title:string;input:Record<string,any>;key:string;attempt:number};
function harness(p:PrdProject,respond:(call:Call)=>Record<string,unknown>){
  const calls:Call[]=[],invalidations:Array<{keys:string[];reason:string}>=[],applied:ClarificationAction[][]=[];
  const cache=new Map<string,unknown>(),attempts=new Map<string,number>();
  const context:ReconciliationContext={
    project:p,instruction:'输出 actions。',units:ids=>{const selected=new Set(ids);return p.sourceUnits.filter(unit=>selected.has(unit.id))},
    measure:(title,contract,input)=>{
      const actual=evidencePromptInput(input).input;return measurePrompt(JSON.stringify({contract,input:actual}),'repair',{});
    },
    ask:async(title,_purpose,_contract,input,accept)=>{
      const key=createHash('sha256').update(JSON.stringify({title,input})).digest('hex');
      if(cache.has(key))return {key,value:structuredClone(cache.get(key)) as ReturnType<typeof accept>};
      const attempt=(attempts.get(key)??0)+1;attempts.set(key,attempt);
      if(attempt>3)throw new Error('平台判断已达到三次重审预算');
      const prepared=evidencePromptInput(input),call={title,input:prepared.input as Record<string,any>,key,attempt};calls.push(call);
      const value=accept(materializeEvidenceSelections(respond(call),prepared.catalog));cache.set(key,structuredClone(value));return {key,value};
    },
    invalidate:async(keys,reason)=>{invalidations.push({keys,reason});for(const key of keys)cache.delete(key)},
    accept:(value,questions,requirements)=>{
      if(!Array.isArray(value)||value.length!==questions.length)throw new Error('actions 未覆盖问题');
      return value.map((raw):ClarificationAction=>{
        if(!raw||!['keep','remove-answered'].includes(raw.action)||raw.clarificationIds?.length!==1||!questions.some(q=>q.id===raw.clarificationIds[0])||!raw.reason)throw new Error('无效澄清动作');
        if(raw.action==='remove-answered'&&(!raw.satisfiedRequirementIds?.length||raw.satisfiedRequirementIds.some((id:string)=>!requirements.some(r=>r.id===id))))throw new Error('回答未引用需求');
        return {action:raw.action,clarificationIds:raw.clarificationIds,reason:raw.reason,satisfiedRequirementIds:raw.satisfiedRequirementIds??[]};
      });
    },
    apply:actions=>{applied.push(actions);for(const action of actions)if(action.action==='remove-answered')for(const q of p.clarifications)if(action.clarificationIds.includes(q.id))q.state='dismissed'},
    parallel:(items,work)=>Promise.all(items.map(work)),
  };
  return {context,calls,invalidations,applied};
}
function businessFixture(exception=false){
  const units=[source('S-A','高风险订单必须二次审核。'),source('S-B','风险分数不低于80分属于高风险。'),...(exception?[source('S-C','特殊订单不再二次审核，但特殊订单的范围尚未定义。')]:[])];
  const q=question('Q1');q.affectedIds=units.map((_unit,index)=>`R${index}`);
  const p=project([q],units);p.requirements=units.map((unit,index)=>({id:`R${index}`,title:unit.excerpt,behavior:unit.excerpt,conditions:[],constraints:[],explicitAcceptanceConditions:[],sourceUnitIds:[unit.id],ruleIds:[],state:'reviewed'}));
  return p;
}
function extracted(call:Call){return {facts:call.input.evidenceCatalog.map((e:any)=>({kind:e.text.includes('不再')?'exception':'fact',statement:e.text,evidenceIds:[e.id]}))}}
function answered(call:Call){return {actions:[{action:'remove-answered',clarificationIds:['Q1'],reason:'90不低于80，属于高风险，需二次审核',satisfiedRequirementIds:['R0','R1'],evidenceIds:call.input.evidenceCatalog.filter((e:any)=>e.sourceUnitId!=='S-C').map((e:any)=>e.id)}]}}

describe('澄清证据联合协议',()=>{
  it('不同分片分别提供阈值和行为，联合后能关闭问题并引用两段原文',async()=>{
    const p=businessFixture(),h=harness(p,call=>{
      if(call.title==='待澄清事项证据提取')return extracted(call);
      if(call.title==='待澄清事项证据分片汇总'){expect(call.input.facts).toHaveLength(2);return answered(call)}
      if(call.title==='待澄清事项联合结论复核'){expect(new Set(call.input.evidenceCatalog.map((e:any)=>e.sourceUnitId))).toEqual(new Set(['S-A','S-B']));return {status:'passed',reason:'联合阈值与行为成立，本片没有例外'}}
      throw new Error(`意外调用 ${call.title}`);
    });
    await reconcileClarifications(h.context);
    expect(h.calls.filter(c=>c.title==='待澄清事项证据提取')).toHaveLength(1);
    expect(h.calls.filter(c=>c.title==='待澄清事项证据分片汇总')).toHaveLength(1);
    expect(p.clarifications[0].state).toBe('dismissed');
  });
  it('其他分片中的例外能否决已回答候选，重审后保留真实业务缺口',async()=>{
    const p=businessFixture(true),h=harness(p,call=>{
      if(call.title==='待澄清事项证据提取')return extracted(call);
      if(call.title==='待澄清事项证据分片汇总')return call.attempt===1?answered(call):{actions:[{action:'keep',clarificationIds:['Q1'],reason:'特殊订单的免审范围尚未定义',satisfiedRequirementIds:[]}]};
      if(call.title==='待澄清事项联合结论复核')return {status:call.input.candidate[0].action==='remove-answered'&&call.input.evidenceCatalog.some((e:any)=>e.sourceUnitId==='S-C')?'rejected':'passed',reason:'免审例外必须参与决定'};
      throw new Error(`意外调用 ${call.title}`);
    });
    const original=h.context.measure;
    h.context.measure=(title,contract,input)=>{const measured=original(title,contract,input);if(title==='待澄清事项联合结论复核'&&(input as Record<string,any>).evidenceSourceRefs.length>2)measured.estimatedTokens=13000;return measured};
    await reconcileClarifications(h.context);
    expect(h.calls.filter(c=>c.title==='待澄清事项证据分片汇总')).toHaveLength(2);
    expect(h.invalidations).toHaveLength(1);expect(h.applied.flat().every(a=>a.action==='keep')).toBe(true);
    expect(p.clarifications[0].state).toBe('open');
  });
  it('事实提取中伪造的证据编号在进入联合裁决前被拒绝',async()=>{
    const h=harness(businessFixture(),()=>({facts:[{kind:'fact',statement:'伪造',evidenceIds:['E999']}]}));
    await expect(reconcileClarifications(h.context)).rejects.toThrow('未提供或过期');expect(h.applied).toEqual([]);
  });
  it('空的未确定说明不能绕过动作覆盖检查',async()=>{
    const h=harness(businessFixture(),call=>call.title==='待澄清事项证据提取'?extracted(call):{unresolved:' '});
    await expect(reconcileClarifications(h.context)).rejects.toThrow('actions 未覆盖问题');expect(h.applied).toEqual([]);
  });
  it('反证发现提取遗漏时重新提取受影响原文，其他报告继续复用',async()=>{
    const p=businessFixture(true),h=harness(p,call=>{
      if(call.title==='待澄清事项证据提取')return call.attempt===1?{facts:(extracted(call).facts as any[]).filter(fact=>!fact.statement.includes('不再'))}:extracted(call);
      if(call.title==='待澄清事项证据分片汇总')return call.input.facts.some((fact:any)=>fact.kind==='exception')?{actions:[{action:'keep',clarificationIds:['Q1'],reason:'特殊订单的免审范围尚未定义',satisfiedRequirementIds:[]}]}:answered(call);
      if(call.title==='待澄清事项联合结论复核')return {status:call.input.candidate[0].action==='remove-answered'&&call.input.evidenceCatalog.some((e:any)=>e.sourceUnitId==='S-C')?'rejected':'passed',reason:'遗漏免审例外'};
      throw new Error(`意外调用 ${call.title}`);
    });
    await reconcileClarifications(h.context);
    expect(h.calls.filter(c=>c.title==='待澄清事项证据提取')).toHaveLength(2);
    expect(h.applied.flat().every(a=>a.action==='keep')).toBe(true);
  });
  it('token 估算增大不改变复核范围，并完整检查全部原文',async()=>{
    const p=businessFixture(true);p.sourceUnits.push(source('S-D','普通订单不必二次审核。'));p.clarifications[0].affectedIds.push('S-D');
    const h=harness(p,call=>{
      if(call.title==='待澄清事项证据提取')return {facts:(extracted(call).facts as any[]).filter(fact=>!fact.statement.includes('不再')&&!fact.statement.includes('普通订单'))};
      if(call.title==='待澄清事项证据分片汇总')return answered({...call,input:{...call.input,evidenceCatalog:call.input.evidenceCatalog.filter((e:any)=>['S-A','S-B'].includes(e.sourceUnitId))}});
      if(call.title==='待澄清事项联合结论复核')return {status:'passed',reason:'预算装箱测试已检查本片'};
      throw new Error(`意外调用 ${call.title}`);
    });
    h.context.measure=()=>measurePrompt('中'.repeat(50000),'repair',{});
    await reconcileClarifications(h.context);
    const checks=h.calls.filter(call=>call.title==='待澄清事项联合结论复核');
    expect(checks).toHaveLength(1);
    expect(new Set(checks.flatMap(call=>call.input.evidenceCatalog.map((e:any)=>e.sourceUnitId)))).toEqual(new Set(['S-A','S-B','S-C','S-D']));
  });
});

describe('澄清问题对关系协议',()=>{
  it('unknown 不会否决已被 same 路径证明的合并',async()=>{
    const h=harness(project(['A','B','C'].map(question)),call=>({relations:call.input.pairs.map((pair:any)=>({pairId:pair.pairId,relation:pair.left==='A'&&pair.right==='C'?'unknown':'same',reason:'核对业务决定'}))}));
    await reconcileRelations(h.context,h.context.project.clarifications);
    expect(h.calls).toHaveLength(1);expect(h.invalidations).toEqual([]);expect(h.applied.flat()).toMatchObject([{action:'merge',clarificationIds:['A','B','C']}]);
  });
  it('真正冲突会重审完整 same 路径，独立 different 判断保持缓存',async()=>{
    const h=harness(project(['A','B','C','D'].map(question)),call=>({relations:call.input.pairs.map((pair:any)=>({pairId:pair.pairId,relation:pair.right==='D'?'different':pair.left==='A'&&pair.right==='C'&&call.attempt===1?'different':'same',reason:'明确业务对象和决定'}))}));
    await reconcileRelations(h.context,h.context.project.clarifications);
    expect(new Set(h.invalidations.flatMap(item=>item.keys)).size).toBe(1);
    expect(h.calls.filter(call=>call.input.pairs.some((pair:any)=>pair.right==='D'))).toHaveLength(2);
    expect(h.calls.filter(call=>call.attempt===2)).toHaveLength(1);
    expect(h.applied.flat()).toMatchObject([{action:'merge',clarificationIds:['A','B','C']}]);
  });
  it('持久缺证不会被标成 different 或通过检查，三轮后明确平台失败',async()=>{
    const h=harness(project(['A','B'].map(question)),call=>({relations:call.input.pairs.map((pair:any)=>({pairId:pair.pairId,relation:'unknown',reason:'缺少区分业务对象的原文'}))}));
    await expect(reconcileRelations(h.context,h.context.project.clarifications)).rejects.toThrow('平台未完成澄清关系核查');
    expect(h.calls).toHaveLength(3);expect(h.invalidations).toHaveLength(3);expect(h.applied).toEqual([]);
  });
  it('关系输出缺少问题对时必须拒绝，不能默认不同',async()=>{
    const h=harness(project(['A','B'].map(question)),()=>({relations:[]}));
    await expect(reconcileRelations(h.context,h.context.project.clarifications)).rejects.toThrow('没有覆盖全部');expect(h.applied).toEqual([]);
  });
});
