import type { Clarification, ClarificationAction, PrdProject, SourceRef, SourceUnit } from '../src/types.js';
import type { PromptMeasurement } from './prompt-budget.js';
import { buildEvidenceCatalog } from './source-evidence.js';
import { reconcileRelations } from './clarification-relations.js';

type Requirements = PrdProject['requirements'];
export interface ReconciliationContext {
  project: PrdProject;
  instruction: string;
  units(ids: Iterable<string>): SourceUnit[];
  measure(title: string, instruction: string, input: unknown): PromptMeasurement;
  ask<T>(title: string, purpose: string, instruction: string, input: unknown, accept: (value: Record<string, unknown>) => T): Promise<{key: string; value: T}>;
  invalidate(keys: string[], reason: string): Promise<void>;
  accept(value: unknown, questions: Clarification[], requirements: Requirements, units: SourceUnit[]): ClarificationAction[];
  apply(actions: ClarificationAction[]): void;
  parallel<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]>;
}

interface Fact { kind: 'fact'|'condition'|'definition'|'exception'|'conflict'; statement: string; sourceRefs: SourceRef[] }
const refKey = (ref: SourceRef) => `${ref.sourceUnitId}:${ref.start}:${ref.end}`;
const uniqueRefs = (refs: SourceRef[]) => [...new Map(refs.map(ref => [refKey(ref), ref])).values()];
const title = '待澄清事项全局有效性与一致性检查';
const extractionTitle = '待澄清事项证据提取';
const summaryTitle = '待澄清事项证据分片汇总';
const factContract = '只提取与 clarification 有关的原文事实、定义、条件、例外和冲突，不决定删除或保留问题。局部缺证不代表原文缺失。输出 {"facts":[{"kind":"fact|definition|condition|exception|conflict","statement":"完整事实","evidenceIds":["提供的证据编号"]}]}。无相关事实时 facts=[]；不得遗漏否定、例外和阈值。';

function acceptFacts(value: Record<string, unknown>, units: SourceUnit[], allowed?: SourceRef[]): Fact[] {
  if (!Array.isArray(value.facts)) throw new Error('证据提取必须返回 facts 数组');
  const known = new Set((allowed ?? buildEvidenceCatalog(units)).map(refKey));
  return value.facts.map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('证据事实必须是对象');
    const fact = raw as Fact;
    if (!['fact','definition','condition','exception','conflict'].includes(fact.kind) || typeof fact.statement !== 'string' || !fact.statement.trim()) throw new Error('证据事实缺少类别或具体内容');
    if (!Array.isArray(fact.sourceRefs) || !fact.sourceRefs.length || fact.sourceRefs.some(ref => !known.has(refKey(ref)))) throw new Error('证据事实必须引用本次提供的固定原文位置');
    return {kind: fact.kind, statement: fact.statement, sourceRefs: uniqueRefs(fact.sourceRefs)};
  });
}

/** 所有候选仅作用于调度器临时副本；局部缺证不能直接变成业务确认。 */
export async function reconcileClarifications(context: ReconciliationContext) {
  const {project} = context;
  const instruction = context.instruction + ' 平台未查清、证据处理未完成不能返回 keep 或新增业务澄清；此时返回 {"unresolved":"具体未完成的核查及所缺证据"}。';
  let leafCount = 0;
  const scope = (questions: Clarification[]) => {
    const ids = new Set(questions.flatMap(question => [...(question.sourceRefs ?? []).map(ref => ref.sourceUnitId), ...question.affectedIds.filter(id => id.startsWith('S-'))]));
    const requirements = project.requirements.filter(requirement => questions.some(question => question.affectedIds.includes(requirement.id)) || requirement.sourceRefs.map(ref=>ref.sourceUnitId).some(id => ids.has(id)));
    return {requirements, units: context.units([...ids, ...requirements.flatMap(requirement => requirement.sourceRefs.map(ref=>ref.sourceUnitId))])};
  };
  const inspect = async (questions: Clarification[], requirements: Requirements, units: SourceUnit[]) => {
    leafCount++;
    for (;;) {
      const result = await context.ask(title, 'clarification-reconciliation', instruction, {sourceUnits: units, requirements, clarifications: questions}, value => {
        if (typeof value.unresolved === 'string' && value.unresolved.trim()) return {actions: [] as ClarificationAction[], unresolved: value.unresolved};
        return {actions: context.accept(value.actions, questions, requirements, units), unresolved: ''};
      });
      if (!result.value.unresolved) return result.value.actions;
      await context.invalidate([result.key], result.value.unresolved);
    }
  };
  const inspectOne = async (question: Clarification, requirements: Requirements, units: SourceUnit[]) => {
    const referenced = new Set(requirements.flatMap(requirement => requirement.sourceRefs.map(ref=>ref.sourceUnitId)));
    const atoms = [...requirements.map(requirement => ({requirements: [requirement], units: context.units(requirement.sourceRefs.map(ref=>ref.sourceUnitId))})), ...units.filter(unit => !referenced.has(unit.id)).map(unit => ({requirements: [] as Requirements, units: [unit]}))];
    const merge = (parts: typeof atoms) => ({requirements: parts.flatMap(part => part.requirements), sourceUnits: [...new Map(parts.flatMap(part => part.units).map(unit => [unit.id, unit])).values()], clarification: question});
    const packs: typeof atoms[] = [];
    let current: typeof atoms = [];
    for (const atom of atoms) {
      if (current.length >= 12) { packs.push(current); current = []; }
      current.push(atom);
    }
    if (current.length) packs.push(current);
    if (!packs.length) return inspect([question], requirements, units);
    leafCount += packs.length;
    const reports = await context.parallel(packs, async pack => {
      const input = merge(pack);
      const result = await context.ask(extractionTitle, 'clarification-evidence-extract', factContract, input, value => acceptFacts(value, input.sourceUnits));
      return {...result, scope: input.sourceUnits.map(unit => unit.id)};
    });
    const allFacts = reports.flatMap(report => report.value);
    const evidenceInput = (facts: Fact[]) => {
      const refs = uniqueRefs(facts.flatMap(fact => fact.sourceRefs));
      return {clarification: question, facts, sourceUnits: context.units(new Set(refs.map(ref => ref.sourceUnitId))), evidenceSourceRefs: refs};
    };
    const jointContract = instruction + ' 当前已完成全部证据分片。可以联合不同分片的定义、条件、规则推导新答案，不得只选择某个分片动作。输出 actions，并在每个 remove-answered 动作提供 evidenceIds。keep 仅限真实业务缺口，不得因分片缺证保留。平台尚未查清返回 {"unresolved":"具体平台问题"}。依据原文事实及例外裁决。';
    const compactRequirements = requirements.map(({id, sourceRefs}) => ({id, sourceRefs}));
    const jointInput = (facts: Fact[]) => ({...evidenceInput(facts), requirements: compactRequirements, clarifications: [question], checkedScopes: reports.map(report => report.scope)});
    const facts = allFacts;
    const input = jointInput(facts);
    for (;;) {
      const candidate = await context.ask(summaryTitle, 'clarification-evidence-summary', jointContract, input, value => {
        if (typeof value.unresolved === 'string' && value.unresolved.trim()) return {actions: [] as ClarificationAction[], unresolved: value.unresolved, refs: [] as SourceRef[]};
        const actions = context.accept(value.actions, [question], requirements, units);
        const refs: SourceRef[] = [];
        for (const raw of value.actions as Array<Record<string, unknown>>) if (raw.action === 'remove-answered') refs.push(...acceptFacts({facts: [{kind: 'fact', statement: raw.reason, sourceRefs: raw.sourceRefs}]}, units, uniqueRefs(facts.flatMap(fact => fact.sourceRefs)))[0].sourceRefs);
        return {actions, refs: uniqueRefs(refs), unresolved: ''};
      });
      if (candidate.value.unresolved) { await context.invalidate([candidate.key], `平台尚未查清：${candidate.value.unresolved}`); continue; }
      const verifyContract = '检查联合候选是否正确处理本片原文中的事实、阈值、定义、否定和例外。结合联合依据判断，不能因本片缺少其他片证据而否定候选。若本片存在被遗漏且会改变结论的依据，返回 rejected 并说明；本片无反证返回 passed；无法判断返回 unknown。输出 {"status":"passed|rejected|unknown","reason":"具体依据"}。保留业务澄清同样必须核查，原文可回答时不得通过。';
      const verifyTitle = '待澄清事项联合结论复核';
      const supportRefs = uniqueRefs(facts.flatMap(fact => fact.sourceRefs));
      const verifyInputFor = (refs: SourceRef[]) => {
        const selected = uniqueRefs([...refs, ...supportRefs]);
        return {clarification: question, candidate: candidate.value.actions, sourceUnits: context.units(new Set(selected.map(ref => ref.sourceUnitId))), evidenceSourceRefs: selected, jointFacts: facts.map(({kind, statement}) => ({kind, statement}))};
      };
      // 复核按最终请求重新装箱，给联合依据预留预算，不沿用提取阶段的满分片。
      const verifyPacks: SourceRef[][] = []; let selected: SourceRef[] = [];
      for (const ref of buildEvidenceCatalog(units)) {
        if (selected.length >= 24) { verifyPacks.push(selected); selected = []; }
        selected.push(ref);
      }
      if (selected.length) verifyPacks.push(selected);
      const checks = await context.parallel(verifyPacks, async refs => {
        const result = await context.ask(verifyTitle, 'clarification-evidence-verify', verifyContract, verifyInputFor(refs), value => {
          if (!['passed','rejected','unknown'].includes(value.status as string) || typeof value.reason !== 'string' || !value.reason.trim()) throw new Error('联合结论复核缺少有效状态或具体依据');
          return {status: value.status as string, reason: value.reason};
        });
        return {...result, scope: new Set(refs.map(ref => ref.sourceUnitId))};
      });
      const failed = checks.filter(check => check.value.status !== 'passed');
      if (!failed.length) return candidate.value.actions;
      const affectedReports = reports.filter(report => failed.some(check => report.scope.some(id => check.scope.has(id))));
      await context.invalidate([candidate.key, ...failed.map(check => check.key), ...affectedReports.map(report => report.key)], failed.map(check => check.value.reason).join('\n'));
      // 反证可能源于提取遗漏，必须重新读取受影响原文，不能仅让汇总重选同一组事实。
      return inspectOne(question, requirements, units);
    }
  };
  const inspectGroup = async (questions: Clarification[]): Promise<ClarificationAction[]> => {
    const results=await context.parallel(questions,question=>{const {requirements,units}=scope([question]);return inspectOne(question,requirements,units)});
    return results.flat();
  };
  const open = project.clarifications.filter(question => question.state === 'open');
  if (!open.length) return;
  context.apply(await inspectGroup(open));
  const remaining = project.clarifications.filter(question => question.state === 'open');
  if (leafCount > 1 && remaining.length > 1) await reconcileRelations(context, remaining);
}
