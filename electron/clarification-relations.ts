import { createHash } from 'node:crypto';
import type { Clarification, ClarificationAction } from '../src/types.js';
import type { ReconciliationContext } from './clarification-reconciliation.js';

type Pair = { pairId: string; left: string; right: string };
type Relation = Pair & { relation: 'same' | 'different' | 'unknown'; reason: string };
type Batch = { pairs: Pair[]; key?: string; relations?: Relation[] };
const title = '待澄清事项跨批一致性检查';
const contract = '检查每个指定问题对是否要求同一个业务决定。只有业务对象、触发条件、待决定规则一致时才 same；明确存在业务差异才 different；缺证用 unknown，未证明相同绝不等于不同。输出 {"relations":[{"pairId":"输入 pairId","relation":"same|different|unknown","reason":"具体业务依据或缺少的证据"}]}。每个输入问题对必须恰好出现一次，不得增删问题或依据问题编号推测关系。重审时结合原文及 conflictingJudgments 重新判断，不能复述已否决的结论。';
const describe = (q: Clarification) => ({ id:q.id,question:q.question,knownFacts:q.knownFacts,unresolvedPoint:q.unresolvedPoint,reason:q.reason,impact:q.impact,affectedIds:q.affectedIds,sourceRefs:q.sourceRefs });

/** 关系判断与最终动作分离；unknown 不构成排斥边，只有全局验证后才合并。 */
export async function reconcileRelations(context: ReconciliationContext, questions: Clarification[]): Promise<void> {
  if(questions.length<2)return;
  const byId=new Map(questions.map(q=>[q.id,q]));
  const inputFor=(batch:Batch)=>{
    const selected=[...new Set(batch.pairs.flatMap(pair=>[pair.left,pair.right]))].map(id=>byId.get(id)!);
    const sourceIds=new Set(selected.flatMap(q=>[...(q.sourceRefs??[]).map(ref=>ref.sourceUnitId),...q.affectedIds.filter(id=>id.startsWith('S-'))]));
    for(const requirement of context.project.requirements)if(selected.some(q=>q.affectedIds.includes(requirement.id)))for(const id of requirement.sourceRefs.map(ref=>ref.sourceUnitId))sourceIds.add(id);
    return {clarifications:selected.map(describe),pairs:batch.pairs,sourceUnits:context.units(sourceIds)};
  };
  const batches:Batch[]=[];let current:Batch={pairs:[]};
  for(let left=0;left<questions.length;left++)for(let right=left+1;right<questions.length;right++){
    const pair={pairId:JSON.stringify([questions[left].id,questions[right].id]),left:questions[left].id,right:questions[right].id};
    if(current.pairs.length>=32){batches.push(current);current={pairs:[]}}
    current.pairs.push(pair);
  }
  if(current.pairs.length)batches.push(current);
  const inspect=async(batch:Batch)=>{
    const input=inputFor(batch);
    const identity=createHash('sha256').update(JSON.stringify(batch.pairs.map(pair=>pair.pairId))).digest('hex').slice(0,16);
    const result=await context.ask(title,`clarification-cross-batch-${identity}`,contract,input,value=>{
      if(!Array.isArray(value.relations))throw new Error('跨批一致性检查缺少 relations');
      const expected=new Map(batch.pairs.map(pair=>[pair.pairId,pair])),seen=new Set<string>();
      const accepted=value.relations.map((raw:unknown):Relation=>{
        if(!raw||typeof raw!=='object')throw new Error('跨批关系必须是对象');
        const item=raw as Record<string,unknown>,pair=expected.get(String(item.pairId));
        if(!pair||seen.has(pair.pairId)||!['same','different','unknown'].includes(String(item.relation))||typeof item.reason!=='string'||!item.reason.trim())throw new Error('跨批关系必须覆盖有效且不重复的问题对并说明依据');
        seen.add(pair.pairId);return {...pair,relation:item.relation as Relation['relation'],reason:item.reason};
      });
      if(seen.size!==expected.size)throw new Error('跨批关系没有覆盖全部指定问题对');
      return accepted;
    });
    batch.key=result.key;batch.relations=result.value;
  };
  let pending=batches;
  for(let round=0;round<3;round++){
    await context.parallel(pending,inspect);
    const parents=new Map(questions.map(q=>[q.id,q.id]));
    const root=(id:string):string=>{let cursor=id;while(parents.get(cursor)!==cursor)cursor=parents.get(cursor)!;return cursor};
    const edges=new Map<string,Array<{to:string;batch:Batch;relation:Relation}>>();
    for(const batch of batches)for(const relation of batch.relations??[])if(relation.relation==='same'){
      parents.set(root(relation.right),root(relation.left));
      for(const [from,to] of [[relation.left,relation.right],[relation.right,relation.left]]){const next=edges.get(from)??[];next.push({to,batch,relation});edges.set(from,next)}
    }
    const disputed=new Map<Batch,string[]>();
    const mark=(batch:Batch,reason:string)=>{const reasons=disputed.get(batch)??[];reasons.push(reason);disputed.set(batch,reasons)};
    for(const batch of batches)for(const relation of batch.relations??[]){
      if(relation.relation==='unknown'&&root(relation.left)!==root(relation.right))mark(batch,`${relation.pairId} 尚未确定：${relation.reason}`);
      if(relation.relation!=='different'||root(relation.left)!==root(relation.right))continue;
      // 找出证明相同的一条完整路径，连同明确不同的判断一起失效，避免重试复用冲突链。
      const queue=[relation.left],visited=new Set(queue),previous=new Map<string,{from:string;batch:Batch;relation:Relation}>();
      for(let cursor=0;cursor<queue.length&&!visited.has(relation.right);cursor++)for(const edge of edges.get(queue[cursor])??[])if(!visited.has(edge.to)){visited.add(edge.to);previous.set(edge.to,{from:queue[cursor],batch:edge.batch,relation:edge.relation});queue.push(edge.to)}
      const path:Array<{batch:Batch;relation:Relation}>=[];let cursor=relation.right;
      while(cursor!==relation.left){const edge=previous.get(cursor)!;path.push(edge);cursor=edge.from}
      const feedback=JSON.stringify({different:relation,samePath:path.map(edge=>edge.relation)});
      mark(batch,feedback);for(const edge of path)mark(edge.batch,feedback);
    }
    if(!disputed.size){
      const components=new Map<string,string[]>();for(const q of questions){const key=root(q.id),ids=components.get(key)??[];ids.push(q.id);components.set(key,ids)}
      const actions:ClarificationAction[]=[...components.values()].filter(ids=>ids.length>1).map(ids=>({action:'merge',clarificationIds:ids,reason:'原文与问题关系检查确认属于同一个业务决定',satisfiedRequirementIds:[]}));
      context.apply(actions);return;
    }
    // 每批只接收与自身有关的矛盾，避免将全局反馈重复灌入每个重审请求。
    for(const [batch,reasons] of disputed)await context.invalidate([batch.key!],[...new Set(reasons)].join('\n'));
    pending=[...disputed.keys()];
    if(round===2)throw new Error(`平台未完成澄清关系核查：${disputed.size} 批判断经三轮仍存在缺证或冲突，具体依据已保存在检查点否决反馈中。`);
  }
}
