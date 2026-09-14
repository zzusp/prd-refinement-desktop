import { createHash } from "node:crypto";
import { DomainValidationError } from "./node-validation.js";
import type {
  Clarification,
  Feature,
  FeedbackAdjustmentPlan,
  FeedbackOperation,
  FeedbackOperationResult,
  PrdProject,
  RefinementAdjustmentRequest,
  RequirementDetail,
  RequirementRelation,
  SourceUnit,
  UserEvidence,
} from "../src/types.js";
import { acceptDirectDetails, acceptRequirementRelations } from "./domain.js";
import {
  evidencePromptInput,
  materializeDetailEvidenceSelections,
  materializeEvidenceSelections,
} from "./source-evidence.js";

export interface AdjustmentModelAdapter {
  generate<T>(input: {
    operation: "adjustmentParse" | "adjustmentGenerate" | "adjustmentRepair" | "adjustmentReview";
    title: string;
    instruction: string;
    input: unknown;
    accept: (value: Record<string, unknown>) => T;
  }): Promise<T>;
}
export interface AdjustmentBase {
  taskId: string;
  version: number;
  project: PrdProject;
  userEvidence?: UserEvidence[];
}
export interface AdjustmentDiff {
  updatedFeatureIds: string[];
  addedRequirementIds: string[];
  removedRequirementIds: string[];
  changedRequirementIds: string[];
  resolvedClarificationIds: string[];
}
export interface AdjustmentRun {
  status: "completed" | "failed";
  baseTaskId: string;
  parentVersion: number;
  version: number;
  project: PrdProject;
  userEvidence: UserEvidence[];
  plan: FeedbackAdjustmentPlan;
  results: FeedbackOperationResult[];
  diff: AdjustmentDiff;
  error?: string;
}
type RequirementAction = {
  action: "create" | "update" | "delete";
  targetId?: string;
  requirement?: RequirementDetail;
};
type ClarificationAction = {
  action: "create" | "update" | "keep" | "resolve" | "dismiss";
  targetId?: string;
  clarification?: Clarification;
  satisfiedRequirementIds: string[];
  resolutionEvidenceIds: string[];
};
type RelationAction = {
  action: "create" | "update" | "delete";
  targetId?: string;
  relation?: RequirementRelation;
};
type Actions = {
  requirementActions: RequirementAction[];
  clarificationActions: ClarificationAction[];
  relationActions: RelationAction[];
};
type Review = {
  passed: boolean;
  issues: string[];
  clarificationResolutions: Array<{
    clarificationId: string;
    status: "supported" | "unsupported";
    reason: string;
  }>;
};
const clone = <T>(v: T): T => structuredClone(v),
  obj = (v: unknown, n: string) => {
    if (!v || typeof v !== "object" || Array.isArray(v))
      throw new DomainValidationError(`${n} 必须是对象`);
    return v as Record<string, unknown>;
  },
  arr = (v: unknown, n: string) => {
    if (!Array.isArray(v)) throw new DomainValidationError(`${n} 必须是数组`);
    return v;
  };
const strs = (v: unknown, n: string) =>
  arr(v, n).map((x, i) => {
    if (typeof x !== "string" || !x.trim())
      throw new DomainValidationError(`${n}[${i}] 必须是非空字符串`);
    return x.trim();
  });
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
const emptyDiff = (): AdjustmentDiff => ({
  updatedFeatureIds: [],
  addedRequirementIds: [],
  removedRequirementIds: [],
  changedRequirementIds: [],
  resolvedClarificationIds: [],
});
const featureSources = (f: Feature, p: PrdProject) =>
  new Set([
    ...f.sourceUnitIds,
    ...f.requirementIds.flatMap(
      (id) => p.requirements.find((r) => r.id === id)?.sourceUnitIds ?? [],
    ),
  ]);

export class RefinementAdjustmentEngine {
  constructor(
    private adapter: AdjustmentModelAdapter,
    private now: () => Date = () => new Date(),
  ) {}
  async run(
    base: AdjustmentBase,
    request: RefinementAdjustmentRequest,
  ): Promise<AdjustmentRun> {
    if (request.baseTaskId !== base.taskId)
      throw new Error("调整请求不属于当前任务");
    if (request.baseVersion !== base.version)
      throw new Error(
        `结果版本已变化：请求基于 ${request.baseVersion}，当前为 ${base.version}`,
      );
    const feedback = request.feedback.trim();
    if (!feedback) throw new Error("调整说明不能为空");
    const plan = await this.parse(
      feedback,
      request.references ?? [],
      request.acceptedProposals ?? (request.acceptedProposalIds??[]).map(clarificationId=>({clarificationId,baseRecommendation:'',finalText:''})),
      base.project,
      ),
      version = base.version + 1,
      evidence = this.evidence(plan, base, version),
      project = clone(base.project),
      diff = emptyDiff(),
      results: FeedbackOperationResult[] = [];
    project.userEvidence = [
      ...(project.userEvidence ?? []),
      ...evidence.filter(
        (item) =>
          !(project.userEvidence ?? []).some((old) => old.id === item.id),
      ),
    ];
    project.sourceUnits.push(
      ...evidence
        .filter(
          (item) =>
            item.businessFact &&
            !project.sourceUnits.some((unit) => unit.id === item.id),
        )
        .map((item) => this.source(item)),
    );
    for (const p of plan.pending)
      results.push({
        operationId: p.id,
        status: "needs-confirmation",
        featureIds: p.candidateFeatureIds,
        clarificationIds: p.candidateClarificationIds,
        detail: p.question,
      });
    for (const op of plan.operations.filter(
      (x) => x.kind === "defer" || x.kind === "question",
    ))
      results.push({
        operationId: op.id,
        status: op.kind === "defer" ? "deferred" : "needs-confirmation",
        featureIds: op.featureIds,
        clarificationIds: op.clarificationIds,
        detail:
          op.kind === "defer"
            ? "已按说明保留现状"
            : "该意见是问题，未作为业务决定执行",
      });
    const actionable = plan.operations.filter((x) =>
      ["organization", "business-fact", "replace-fact"].includes(x.kind),
    );
    const components: FeedbackOperation[][] = [];
    for (const operation of actionable) {
      const touching = components.filter((component) =>
        component.some(
          (other) =>
            other.featureIds.some((id) => operation.featureIds.includes(id)) ||
            (operation.atomicGroupId &&
              operation.atomicGroupId === other.atomicGroupId),
        ),
      );
      if (!touching.length) components.push([operation]);
      else {
        touching[0].push(operation);
        for (const extra of touching.slice(1)) {
          touching[0].push(...extra);
          components.splice(components.indexOf(extra), 1);
        }
      }
    }
    for (const operations of components) {
      const before = clone(project),
        diffBefore = clone(diff),
        groups = new Map<string, FeedbackOperation[]>();
      for (const operation of operations)
        for (const id of operation.featureIds)
          groups.set(id, [...(groups.get(id) ?? []), operation]);
      try {
        for (const [featureId, grouped] of groups)
          await this.applyFeature(
            project,
            featureId,
            grouped,
            evidence,
            version,
            diff,
          );
        for (const operation of operations)
          results.push({
            operationId: operation.id,
            status: "applied",
            featureIds: operation.featureIds,
            clarificationIds: operation.clarificationIds,
            detail: "已生成并通过依据核查",
          });
      } catch (error) {
        Object.assign(project, before);
        Object.assign(diff, diffBefore);
        const detail = error instanceof Error ? error.message : String(error);
        for (const operation of operations)
          results.push({
            operationId: operation.id,
            status: "failed",
            featureIds: operation.featureIds,
            clarificationIds: operation.clarificationIds,
            detail,
          });
      }
    }
    for (const op of actionable.filter((x) => !x.featureIds.length))
      results.push({
        operationId: op.id,
        status: "needs-confirmation",
        featureIds: [],
        clarificationIds: op.clarificationIds,
        detail: "无法唯一定位受影响功能，请补充业务对象",
      });
    project.revision = version;
    const failed = results.filter((x) => x.status === "failed");
    const failedOperationIds = new Set(failed.map((item) => item.operationId));
    const allActionableFailed =
      actionable.length > 0 &&
      actionable.every((item) => failedOperationIds.has(item.id));
    return {
      status: allActionableFailed ? "failed" : "completed",
      baseTaskId: base.taskId,
      parentVersion: base.version,
      version,
      project,
      userEvidence: evidence,
      plan,
      results,
      diff,
      error: failed.length
        ? `有 ${failed.length} 条意见未能应用：${failed.map((x) => x.detail).join("；")}`
        : undefined,
    };
  }
  private async parse(
    feedback: string,
    references: NonNullable<RefinementAdjustmentRequest["references"]>,
    acceptedProposals: NonNullable<RefinementAdjustmentRequest['acceptedProposals']>,
    project: PrdProject,
  ): Promise<FeedbackAdjustmentPlan> {
    return this.adapter.generate({
        operation: "adjustmentParse",
        title: "解析任务调整说明",
        instruction:
          '拆分用户意见。quote 必须逐字来自 feedback。organization 只是整理/粒度指令；business-fact 是明确业务口径；replace-fact 是明确替换旧口径；defer 是暂不处理；question 是询问。按功能、需求正文和澄清定位明确目标。acceptedProposals 中的 finalText 是用户实际采纳的业务决定，baseRecommendation 只用于版本校验；如果 feedback 另有明确例外或替换口径，以用户补充口径为准，不得同时生成冲突操作。存在多个合理候选、冲突或缺少决定时不得猜，写入 pending。输出 {"operations":[{"id":"O1","quote":"原文片段","kind":"organization|business-fact|replace-fact|defer|question","instruction":"执行意图","featureIds":[],"clarificationIds":[],"atomicGroupId":"可选"}],"pending":[{"id":"P1","quote":"原文片段","question":"具体待确认问题","candidateFeatureIds":[],"candidateClarificationIds":[]}]}。',
        input: {
          feedback,
          references,
          acceptedProposals,
          features: project.features.map((f) => ({
            id: f.id,
            name: f.name ?? f.id,
            requirements: project.requirements
              .filter((r) => f.requirementIds.includes(r.id))
              .map((r) => ({ id: r.id, title: r.title, behavior: r.behavior })),
          })),
          clarifications: project.clarifications
            .filter((q) => q.state === "open")
            .map((q) => ({
              id: q.id,
              question: q.question,
              knownFacts: q.knownFacts,
              unresolvedPoint: q.unresolvedPoint,
              affectedIds: q.affectedIds,
            })),
        },
        accept: (raw) => this.acceptPlan(raw, feedback, project),
      });
  }
  private acceptPlan(raw: Record<string, unknown>, feedback: string, project: PrdProject): FeedbackAdjustmentPlan {
    const p = obj(raw, "反馈解析结果"),
      featureIds = new Set(project.features.map((x) => x.id)),
      questionIds = new Set(project.clarifications.map((x) => x.id)),
      used = new Set<string>();
    const quote = (v: unknown, n: string) => {
      if (typeof v !== "string" || !v.trim() || !feedback.includes(v))
        throw new DomainValidationError(`${n} 必须逐字存在于用户调整说明中`);
      return v;
    };
    const operations = arr(p.operations, "operations").map((raw, i) => {
      const x = obj(raw, `operations[${i}]`),
        id = String(x.id ?? "").trim(),
        kind = x.kind,
        q = quote(x.quote, `operations[${i}].quote`),
        fs = strs(x.featureIds ?? [], `operations[${i}].featureIds`),
        qs = strs(
          x.clarificationIds ?? [],
          `operations[${i}].clarificationIds`,
        );
      if (!id || used.has(id))
        throw new DomainValidationError(`operations[${i}].id 非法或重复`);
      used.add(id);
      if (
        ![
          "organization",
          "business-fact",
          "replace-fact",
          "defer",
          "question",
        ].includes(String(kind))
      )
        throw new DomainValidationError(`operations[${i}].kind 非法`);
      if (
        fs.some((id) => !featureIds.has(id)) ||
        qs.some((id) => !questionIds.has(id))
      )
        throw new DomainValidationError(`operations[${i}] 引用了不存在的目标`);
      if (!fs.length && !qs.length)
        throw new DomainValidationError(`operations[${i}] 没有明确目标，应放入 pending`);
      if (
        ["organization", "business-fact", "replace-fact"].includes(
          String(kind),
        ) &&
        !fs.length
      )
        throw new DomainValidationError(
          `operations[${i}] 没有可执行功能，应根据澄清影响定位功能或放入 pending`,
        );
      return {
        id,
        quote: q,
        kind,
        instruction: String(x.instruction ?? "").trim() || q,
        featureIds: fs,
        clarificationIds: qs,
        ...(typeof x.atomicGroupId === "string" && x.atomicGroupId.trim()
          ? { atomicGroupId: x.atomicGroupId.trim() }
          : {}),
      } as FeedbackOperation;
    });
    const pending = arr(p.pending ?? [], "pending").map((raw, i) => {
      const x = obj(raw, `pending[${i}]`),
        id = String(x.id ?? "").trim(),
        q = quote(x.quote, `pending[${i}].quote`),
        question = String(x.question ?? "").trim(),
        fs = strs(
          x.candidateFeatureIds ?? [],
          `pending[${i}].candidateFeatureIds`,
        ),
        qs = strs(
          x.candidateClarificationIds ?? [],
          `pending[${i}].candidateClarificationIds`,
        );
      if (!id || used.has(id) || !question)
        throw new DomainValidationError(`pending[${i}] 缺少唯一编号或具体问题`);
      used.add(id);
      if (
        fs.some((id) => !featureIds.has(id)) ||
        qs.some((id) => !questionIds.has(id))
      )
        throw new DomainValidationError(`pending[${i}] 引用了不存在的候选`);
      return {
        id,
        quote: q,
        question,
        candidateFeatureIds: fs,
        candidateClarificationIds: qs,
      };
    });
    return { operations, pending };
  }
  private evidence(
    plan: FeedbackAdjustmentPlan,
    base: AdjustmentBase,
    version: number,
  ): UserEvidence[] {
    return plan.operations.map((op) => {
      const businessFact =
          op.kind === "business-fact" || op.kind === "replace-fact",
        id = `USER-${version}-${digest([op.id, op.quote, op.featureIds, op.clarificationIds])}`;
      return clone(
        base.userEvidence?.find((x) => x.id === id) ?? {
          id,
          author: "user",
          kind: businessFact ? "supplement" : "refinement-instruction",
          content: op.quote,
          createdAt: this.now().toISOString(),
          appliesTo: {
            scope:
              op.featureIds.length === base.project.features.length
                ? "all"
                : "feature",
            featureIds: op.featureIds,
            clarificationIds: op.clarificationIds,
          },
          version,
          businessFact,
        },
      );
    });
  }
  private source(e: UserEvidence): SourceUnit {
    return {
      id: e.id,
      label: "用户补充",
      kind: "paragraph",
      excerpt: e.content,
      location: `用户输入 · ${e.createdAt}`,
      status: "processed",
      synthetic: true,
    };
  }
  private async applyFeature(
    project: PrdProject,
    featureId: string,
    ops: FeedbackOperation[],
    allEvidence: UserEvidence[],
    version: number,
    diff: AdjustmentDiff,
  ) {
    const feature = project.features.find((x) => x.id === featureId);
    if (!feature) throw new Error(`功能不存在：${featureId}`);
    const sourceIds = featureSources(feature, project),
      evidence = allEvidence.filter((e) =>
        ops.some((op) => op.quote === e.content),
      ),
      units = [
        ...project.sourceUnits.filter((x) => sourceIds.has(x.id)),
        ...evidence.map((x) => this.source(x)),
      ],
      old = clone(
        project.requirements.filter((x) =>
          feature.requirementIds.includes(x.id),
        ),
      ),
      questions = project.clarifications.filter(
        (q) =>
          q.affectedIds.some(
            (id) => feature.requirementIds.includes(id) || sourceIds.has(id),
          ) || ops.some((op) => op.clarificationIds.includes(q.id)),
      ),
      prepared = evidencePromptInput({
        projectContextHash: digest(project),
        feature,
        currentRequirements: old,
        clarifications: questions,
        relations: (project.relations ?? []).filter(
          (x) =>
            feature.requirementIds.includes(x.sourceRequirementId) ||
            feature.requirementIds.includes(x.targetRequirementId),
        ),
        sourceUnits: units,
        userOpinions: ops.map((op) => ({
          operation: op,
          evidence: evidence.find((e) => e.content === op.quote),
          notice:
            op.kind === "organization"
              ? "整理指令不是业务事实"
              : "用户明确业务依据",
        })),
      });
    const accept = (raw: Record<string, unknown>) => this.applyActions(
      project, feature, questions, this.accept(raw, prepared.catalog, units), version, ops, evidence,
    );
    let candidate = await this.adapter.generate({
        operation: "adjustmentGenerate",
        title: `批量调整功能：${feature.name ?? feature.id}`,
        instruction: this.generationInstruction(),
        input: prepared.input,
        accept,
      }),
      review = await this.review(
        candidate,
        feature,
        units,
        questions,
        ops,
        evidence,
      );
    if (!review.passed) {
      candidate = await this.adapter.generate({
        operation: "adjustmentRepair",
        title: `批量调整功能·有据修正：${feature.name ?? feature.id}`,
        instruction: `只修正以下依据问题并返回完整显式动作：${review.issues.join("；")}`,
        input: {
          originalInput: prepared.input,
          candidate: this.snapshot(candidate, feature),
          review,
        },
        accept,
      });
      review = await this.review(
        candidate,
        feature,
        units,
        questions,
        ops,
        evidence,
      );
      if (!review.passed)
        throw new Error(
          `依据核查未通过：${review.issues.join("；") || "语义依据不足"}`,
        );
    }
    const previous = new Set(feature.requirementIds),
      next = candidate.features.find((x) => x.id === feature.id)!,
      current = candidate.requirements.filter((x) =>
        next.requirementIds.includes(x.id),
      ),
      oldById = new Map(old.map((x) => [x.id, x]));
    project.requirements = candidate.requirements;
    project.clarifications = candidate.clarifications;
    project.relations = candidate.relations;
    Object.assign(feature, next);
    diff.updatedFeatureIds.push(feature.id);
    diff.addedRequirementIds.push(
      ...current.filter((x) => !oldById.has(x.id)).map((x) => x.id),
    );
    diff.changedRequirementIds.push(
      ...current
        .filter(
          (x) =>
            oldById.has(x.id) &&
            JSON.stringify(oldById.get(x.id)) !== JSON.stringify(x),
        )
        .map((x) => x.id),
    );
    diff.removedRequirementIds.push(
      ...[...previous].filter((id) => !feature.requirementIds.includes(id)),
    );
    diff.resolvedClarificationIds.push(
      ...questions
        .filter(
          (q) =>
            q.state === "open" &&
            project.clarifications.find((x) => x.id === q.id)?.state ===
              "resolved",
        )
        .map((x) => x.id),
    );
  }
  private generationInstruction() {
    return '一次落实 userOpinions 的全部意见。organization 只改变组织和表达，不得产生业务规则；只可引用 business-fact/replace-fact 对应用户证据。不得执行 defer/question。返回 {"requirementActions":[{"action":"create|update|delete","targetId":"update/delete 必填","requirement":"create/update 必填"}],"clarificationActions":[{"action":"create|update|keep|resolve|dismiss","targetId":"除 create 外必填","clarification":"create/update 必填","satisfiedRequirementIds":[],"resolutionEvidenceIds":[]}],"relationActions":[]}。requirement 使用 {id,title,behavior:{text,evidenceIds},conditions:[{text,evidenceIds}],constraints:[{text,evidenceIds}],explicitAcceptanceEvidenceIds:[]}；每项业务文本必须配对非空 evidenceIds。不得生成 evidenceBindings、sourceUnitIds、state 或字符位置。未返回动作的旧条目保留；只有答案被需求承接才 resolve。';
  }
  private accept(
    value: unknown,
    catalog: Parameters<typeof materializeEvidenceSelections>[1],
    units: SourceUnit[],
  ): Actions {
    const proposal = obj(value, "调整模型返回");
    const rawRequirementActions = arr(proposal.requirementActions, "requirementActions");
    const p = obj(
      materializeEvidenceSelections({ ...proposal, requirementActions: [] }, catalog),
      "调整模型返回",
    );
    const requirementActions = arr(
      rawRequirementActions,
      "requirementActions",
    ).map((raw, i) => {
      const x = obj(raw, `requirementActions[${i}]`),
        action = x.action,
        targetId =
          typeof x.targetId === "string" ? x.targetId.trim() : undefined;
      if (
        !["create", "update", "delete"].includes(String(action)) ||
        (action !== "create" && !targetId)
      )
        throw new DomainValidationError(`requirementActions[${i}] 非法`);
      return {
        action,
        targetId,
        requirement:
          action === "delete"
            ? undefined
            : acceptDirectDetails(materializeDetailEvidenceSelections({ requirements: [x.requirement], clarifications: [] }, catalog).requirements, [], units, true)
                .requirements[0],
      } as RequirementAction;
    });
    const clarificationActions = arr(
      p.clarificationActions ?? [],
      "clarificationActions",
    ).map((raw, i) => {
      const x = obj(raw, `clarificationActions[${i}]`),
        action = x.action,
        targetId =
          typeof x.targetId === "string" ? x.targetId.trim() : undefined;
      if (
        !["create", "update", "keep", "resolve", "dismiss"].includes(
          String(action),
        ) ||
        (action !== "create" && !targetId)
      )
        throw new DomainValidationError(`clarificationActions[${i}] 非法`);
      return {
        action,
        targetId,
        clarification:
          action === "create" || action === "update"
            ? acceptDirectDetails([], [{ ...obj(x.clarification, `clarificationActions[${i}].clarification`), state: "open" }], units, true)
                .clarifications[0]
            : undefined,
        satisfiedRequirementIds: strs(
          x.satisfiedRequirementIds ?? [],
          `clarificationActions[${i}].satisfiedRequirementIds`,
        ),
        resolutionEvidenceIds: strs(
          x.resolutionEvidenceIds ?? [],
          `clarificationActions[${i}].resolutionEvidenceIds`,
        ),
      } as ClarificationAction;
    });
    const relationActions = arr(p.relationActions ?? [], "relationActions").map(
      (raw, i) => {
        const x = obj(raw, `relationActions[${i}]`),
          action = x.action,
          targetId =
            typeof x.targetId === "string" ? x.targetId.trim() : undefined;
        if (
          !["create", "update", "delete"].includes(String(action)) ||
          (action !== "create" && !targetId)
        )
          throw new DomainValidationError(`relationActions[${i}] 非法`);
        return {
          action,
          targetId,
          relation: x.relation as RequirementRelation | undefined,
        } as RelationAction;
      },
    );
    return { requirementActions, clarificationActions, relationActions };
  }
  private applyActions(
    project: PrdProject,
    feature: Feature,
    questions: Clarification[],
    actions: Actions,
    version: number,
    ops: FeedbackOperation[],
    evidence: UserEvidence[],
  ) {
    const result = clone(project),
      target = result.features.find((x) => x.id === feature.id)!,
      owned = new Set(target.requirementIds),
      used = new Set(result.requirements.map((x) => x.id)),
      remaps = new Map<string, string>();
    this.unique(actions.requirementActions, "需求");
    this.unique(actions.clarificationActions, "澄清");
    this.unique(actions.relationActions, "关系");
    for (const [i, a] of actions.requirementActions.entries()) {
      if (a.action === "create") {
        const created = clone(a.requirement!),
          old = created.id;
        let id = `R-ADJ-${version}-${feature.id}-${i + 1}`,
          n = 1;
        while (used.has(id))
          id = `R-ADJ-${version}-${feature.id}-${i + 1}-${++n}`;
        created.id = id;
        used.add(id);
        remaps.set(old, id);
        result.requirements.push(created);
        target.requirementIds.push(id);
        continue;
      }
      if (!owned.has(a.targetId!))
        throw new DomainValidationError(`需求动作越出当前功能：${a.targetId}`);
      const at = result.requirements.findIndex((x) => x.id === a.targetId);
      if (at < 0) throw new DomainValidationError(`需求不存在：${a.targetId}`);
      if (a.action === "delete") {
        result.requirements.splice(at, 1);
        target.requirementIds = target.requirementIds.filter(
          (id) => id !== a.targetId,
        );
      } else
        result.requirements[at] = { ...clone(a.requirement!), id: a.targetId! };
    }
    const valid = new Set(result.requirements.map((x) => x.id)),
      remap = (id: string) => remaps.get(id) ?? id,
      related = new Set(questions.map((x) => x.id)),
      allowed = new Set(ops.flatMap((x) => x.clarificationIds)),
      facts = new Set(evidence.filter((x) => x.businessFact).map((x) => x.id));
    for (const a of actions.clarificationActions) {
      if (a.action === "create") {
        const q = clone(a.clarification!);
        q.id = `Q-ADJ-${version}-${feature.id}-${result.clarifications.length + 1}`;
        q.affectedIds = q.affectedIds.map(remap);
        result.clarifications.push(q);
        continue;
      }
      if (!related.has(a.targetId!))
        throw new DomainValidationError(`澄清动作越出当前范围：${a.targetId}`);
      const q = result.clarifications.find((x) => x.id === a.targetId)!;
      if (a.action === "keep") continue;
      if (a.action === "update") {
        Object.assign(q, clone(a.clarification!), {
          id: q.id,
          affectedIds: a.clarification!.affectedIds.map(remap),
        });
        continue;
      }
      if (!allowed.has(q.id)) throw new DomainValidationError(`用户意见未明确指向澄清 ${q.id}`);
      if (
        !a.resolutionEvidenceIds.length ||
        a.resolutionEvidenceIds.some((id) => !facts.has(id))
      )
        throw new DomainValidationError(`${q.id} 只能由明确业务事实处理`);
      if (a.action === "dismiss") q.state = "dismissed";
      else {
        const ids = a.satisfiedRequirementIds.map(remap);
        if (!ids.length || ids.some((id) => !valid.has(id)))
          throw new DomainValidationError(`${q.id} resolve 必须指向有效承接需求`);
        q.state = "resolved";
      }
      q.resolutionSourceUnitIds = [
        ...new Set([
          ...(q.resolutionSourceUnitIds ?? []),
          ...a.resolutionEvidenceIds,
        ]),
      ];
    }
    for (const a of actions.relationActions) {
      const relations = (result.relations ??= []);
      if (a.action === "create") {
        if (!a.relation) throw new DomainValidationError("create relation 缺失");
        relations.push({
          ...clone(a.relation),
          id: `REL-ADJ-${version}-${relations.length + 1}`,
          sourceRequirementId: remap(a.relation.sourceRequirementId),
          targetRequirementId: remap(a.relation.targetRequirementId),
        });
        continue;
      }
      const at = relations.findIndex((x) => x.id === a.targetId);
      if (at < 0) throw new DomainValidationError(`关系不存在：${a.targetId}`);
      if (a.action === "delete") relations.splice(at, 1);
      else if (a.relation)
        relations[at] = {
          ...clone(a.relation),
          id: a.targetId!,
          sourceRequirementId: remap(a.relation.sourceRequirementId),
          targetRequirementId: remap(a.relation.targetRequirementId),
        };
    }
    for (const q of result.clarifications)
      q.affectedIds = q.affectedIds.map(remap);
    if (
      result.clarifications.some((q) =>
        q.affectedIds.some((id) => id.startsWith("R") && !valid.has(id)),
      )
    )
      throw new DomainValidationError("删除需求后存在悬空澄清引用");
    result.relations = acceptRequirementRelations(
      result.relations ?? [],
      result.sourceUnits.concat(evidence.map((x) => this.source(x))),
      result.requirements,
    );
    const forbidden = new Set(
      evidence.filter((x) => !x.businessFact).map((x) => x.id),
    );
    for (const r of result.requirements) {
      const refs = [
        ...(r.evidenceBindings?.behavior ?? []),
        ...(r.evidenceBindings?.conditions.flat() ?? []),
        ...(r.evidenceBindings?.constraints.flat() ?? []),
        ...(r.evidenceBindings?.explicitAcceptanceConditions.flat() ?? []),
      ];
      if (refs.some((ref) => forbidden.has(ref.sourceUnitId)))
        throw new DomainValidationError("整理指令不能作为业务事实依据");
    }
    target.state = result.clarifications.some(
      (q) =>
        q.state === "open" &&
        q.level === "blocking" &&
        q.affectedIds.some(
          (id) =>
            target.requirementIds.includes(id) ||
            target.sourceUnitIds.includes(id),
        ),
    )
      ? "needs-clarification"
      : "reviewed";
    return result;
  }
  private async review(
    candidate: PrdProject,
    feature: Feature,
    units: SourceUnit[],
    before: Clarification[],
    ops: FeedbackOperation[],
    evidence: UserEvidence[],
  ): Promise<Review> {
    return this.adapter.generate({
        operation: "adjustmentReview",
        title: `批量调整依据核查：${feature.name ?? feature.id}`,
        instruction:
          '只核查候选已有主张是否由 PRD 或 businessFact=true 的用户意见片段支持，不寻找遗漏。关闭澄清必须准确承接答案。输出 {"passed":boolean,"issues":[],"clarificationResolutions":[{"clarificationId":"Q","status":"supported|unsupported","reason":"原因"}]}。',
        input: {
          sourceUnits: units,
          beforeClarifications: before,
          operations: ops,
          userEvidence: evidence,
          candidate: this.snapshot(candidate, feature),
        },
        accept: (raw) => this.acceptReview(raw, candidate, before),
      });
  }
  private acceptReview(raw: Record<string, unknown>, candidate: PrdProject, before: Clarification[]): Review {
    const p = obj(raw, "依据核查结果");
    if (typeof p.passed !== "boolean")
      throw new DomainValidationError("依据核查结果 passed 必须是布尔值");
    const issues = strs(p.issues ?? [], "依据核查结果.issues"),
      clarificationResolutions = arr(
        p.clarificationResolutions ?? [],
        "依据核查结果.clarificationResolutions",
      ).map((raw, i) => {
        const x = obj(raw, `clarificationResolutions[${i}]`);
        if (
          typeof x.clarificationId !== "string" ||
          !["supported", "unsupported"].includes(String(x.status)) ||
          typeof x.reason !== "string"
        )
          throw new DomainValidationError(`clarificationResolutions[${i}] 非法`);
        return {
          clarificationId: x.clarificationId,
          status: x.status as "supported" | "unsupported",
          reason: x.reason,
        };
      });
    for (const q of candidate.clarifications.filter(
      (q) =>
        q.state !== "open" &&
        before.some((old) => old.id === q.id && old.state === "open"),
    ))
      if (
        !clarificationResolutions.some(
          (x) => x.clarificationId === q.id && x.status === "supported",
        )
      )
        return {
          passed: false,
          issues: [...issues, `${q.id} 的处理未通过依据核查`],
          clarificationResolutions,
        };
    return { passed: p.passed, issues, clarificationResolutions };
  }
  private snapshot(project: PrdProject, feature: Feature) {
    const current = project.features.find((x) => x.id === feature.id)!;
    return {
      feature: current,
      requirements: project.requirements.filter((x) =>
        current.requirementIds.includes(x.id),
      ),
      clarifications: project.clarifications.filter((x) =>
        x.affectedIds.some(
          (id) =>
            current.requirementIds.includes(id) ||
            current.sourceUnitIds.includes(id),
        ),
      ),
      relations: (project.relations ?? []).filter(
        (x) =>
          current.requirementIds.includes(x.sourceRequirementId) ||
          current.requirementIds.includes(x.targetRequirementId),
      ),
    };
  }
  private unique(items: Array<{ targetId?: string }>, label: string) {
    const seen = new Set<string>();
    for (const x of items)
      if (x.targetId) {
        if (seen.has(x.targetId))
          throw new DomainValidationError(`${label}重复操作 ${x.targetId}`);
        seen.add(x.targetId);
      }
  }
}
