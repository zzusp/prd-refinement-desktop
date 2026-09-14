import { createHash } from "node:crypto";
import { DomainValidationError } from "./node-validation.js";
import type {
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
type RelationAction = {
  action: "create" | "update" | "delete";
  targetId?: string;
  relation?: RequirementRelation;
};
type Actions = {
  requirementActions: RequirementAction[];
  relationActions: RelationAction[];
};
type Review = {
  passed: boolean;
  issues: string[];
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
      (id) => p.requirements.find((r) => r.id === id)?.sourceRefs.map(ref=>ref.sourceUnitId) ?? [],
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
    if(request.acceptedProposals?.length||request.acceptedProposalIds?.length||request.references?.some(item=>item.kind==='clarification'))throw new Error('当前版本仅支持功能与需求清单调整');
    if(base.project.clarifications.length)throw new Error('旧版结果仅供查看，请用原始材料创建新任务');
    const feedback = request.feedback.trim();
    if (!feedback) throw new Error("调整说明不能为空");
    const plan = await this.parse(
      feedback,
      request.references ?? [],
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
    for(const operation of plan.operations.filter(item=>item.kind==='business-fact'||item.kind==='replace-fact')){
      results.push({operationId:operation.id,status:'deferred',featureIds:operation.featureIds,clarificationIds:[],detail:'该说明包含新增业务规则，须先更新 PRD 后重新分析；清单保持不变'});
    }
    for (const op of plan.operations.filter(
      (x) => x.kind === "defer" || x.kind === "question",
    ))
      results.push({
        operationId: op.id,
        status: "deferred",
        featureIds: op.featureIds,
        clarificationIds: [],
        detail:
          op.kind === "defer"
            ? "已按说明保留现状"
            : "该意见是问题，未作为业务决定执行",
      });
    const actionable = plan.operations.filter((x) =>
      x.kind === "organization",
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
            clarificationIds: [],
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
            clarificationIds: [],
            detail,
          });
      }
    }
    for (const op of actionable.filter((x) => !x.featureIds.length))
      results.push({
        operationId: op.id,
        status: "failed",
        featureIds: [],
        clarificationIds: [],
        detail: "无法定位调整范围，清单保持不变",
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
    project: PrdProject,
  ): Promise<FeedbackAdjustmentPlan> {
    return this.adapter.generate({
        operation: "adjustmentParse",
        title: "解析任务调整说明",
        instruction:
          '只解析用户提供的调整说明，不生成业务澄清或建议。quote 必须逐字来自 feedback。organization 表示整理、粒度或按 PRD 补漏；business-fact/replace-fact 是新增或替换业务规则，不得当作 PRD 事实执行；defer/question 表示暂不执行或询问。按模块与需求定位目标；不能定位时 featureIds 返回空数组并在 instruction 说明原因，不猜测范围。输出 {"operations":[{"id":"O1","quote":"用户原话","kind":"organization|business-fact|replace-fact|defer|question","instruction":"执行意图","featureIds":[],"atomicGroupId":"可选"}]}。',
        input: {
          feedback,
          references,
          features: project.features.map((f) => ({
            id: f.id,
            name: f.name ?? f.id,
            requirements: project.requirements
              .filter((r) => f.requirementIds.includes(r.id))
              .map((r) => ({ id: r.id, text: r.text })),
          })),
        },
        accept: (raw) => this.acceptPlan(raw, feedback, project),
      });
  }
  private acceptPlan(raw: Record<string, unknown>, feedback: string, project: PrdProject): FeedbackAdjustmentPlan {
    const p = obj(raw, "反馈解析结果"),
      featureIds = new Set(project.features.map((x) => x.id)),
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
        fs = strs(x.featureIds ?? [], `operations[${i}].featureIds`);
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
      if(fs.some(id=>!featureIds.has(id)))throw new DomainValidationError(`operations[${i}] 引用了不存在的目标`);
      return {
        id,
        quote: q,
        kind,
        instruction: String(x.instruction ?? "").trim() || q,
        featureIds: fs,
        ...(typeof x.atomicGroupId === "string" && x.atomicGroupId.trim()
          ? { atomicGroupId: x.atomicGroupId.trim() }
          : {}),
      } as FeedbackOperation;
    });
    return { operations };
  }
  private evidence(
    plan: FeedbackAdjustmentPlan,
    base: AdjustmentBase,
    version: number,
  ): UserEvidence[] {
    return plan.operations.map((op) => {
      const businessFact =
          op.kind === "business-fact" || op.kind === "replace-fact",
        id = `USER-${version}-${digest([op.id, op.quote, op.featureIds])}`;
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
            clarificationIds: [],
          },
          version,
          businessFact: false,
        },
      );
    });
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
        ...project.sourceUnits.filter((x) => sourceIds.has(x.id)&&!x.synthetic&&(!x.sourceRole||x.sourceRole==='primary')),
      ],
      old = clone(
        project.requirements.filter((x) =>
          feature.requirementIds.includes(x.id),
        ),
      ),
      prepared = evidencePromptInput({
        projectContextHash: digest(project),
        feature,
        currentRequirements: old,
        relations: (project.relations ?? []).filter(
          (x) =>
            feature.requirementIds.includes(x.sourceRequirementId) ||
            feature.requirementIds.includes(x.targetRequirementId),
        ),
        sourceUnits: units,
        userOpinions: ops.map((op) => ({
          operation: op,
          evidence: evidence.find((e) => e.content === op.quote),
          notice: "整理指令不是业务事实，只能整理主PRD已有要求",
        })),
      });
    const accept = (raw: Record<string, unknown>) => this.applyActions(
      project, feature, this.accept(raw, prepared.catalog, units, feature.id), version, ops, evidence,
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
  }
  private generationInstruction() {
    return '只落实 organization 的组织和粒度要求；正式需求仅引用主 PRD，用户意见不是业务依据。返回 {"requirementActions":[{"action":"create|update|delete","targetId":"update/delete 必填","requirement":"create/update 必填"}],"relationActions":[]}。requirement 使用 {id,featureId,text,evidenceIds}，text 是简短检查项并保留原文必要限定。不得生成待处理事项、建议或澄清。未返回动作保留；关系仅限原文明示关系。';
  }
  private accept(
    value: unknown,
    catalog: Parameters<typeof materializeEvidenceSelections>[1],
    units: SourceUnit[],
    featureId: string,
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
            : acceptDirectDetails(materializeDetailEvidenceSelections({ requirements: [x.requirement] }, catalog, featureId).requirements, [], units, true)
                .requirements[0],
      } as RequirementAction;
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
    return { requirementActions, relationActions };
  }
  private applyActions(
    project: PrdProject,
    feature: Feature,
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
    const remap = (id:string) => remaps.get(id) ?? id;
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
    result.relations = acceptRequirementRelations(
      result.relations ?? [],
      result.sourceUnits,
      result.requirements,
    );
    const forbidden = new Set(
      evidence.filter((x) => !x.businessFact).map((x) => x.id),
    );
    for (const r of result.requirements) {
      const refs = r.sourceRefs;
      if (refs.some((ref) => forbidden.has(ref.sourceUnitId)))
        throw new DomainValidationError("整理指令不能作为业务事实依据");
    }
    target.state = "reviewed";
    return result;
  }
  private async review(
    candidate: PrdProject,
    feature: Feature,
    units: SourceUnit[],
    ops: FeedbackOperation[],
    evidence: UserEvidence[],
  ): Promise<Review> {
    return this.adapter.generate({
        operation: "adjustmentReview",
        title: `批量调整依据核查：${feature.name ?? feature.id}`,
        instruction:
          '只核查候选需求是否忠于主 PRD，检查无依据新增和原文必要限定丢失。不要进行业务阻塞分析，不生成待处理事项或建议。输出 {"passed":boolean,"issues":[]}。',
        input: {
          sourceUnits: units,
          operations: ops,
          userEvidence: evidence,
          candidate: this.snapshot(candidate, feature),
        },
        accept: (raw) => this.acceptReview(raw),
      });
  }
  private acceptReview(raw: Record<string, unknown>): Review {
    const p = obj(raw, "依据核查结果");
    if (typeof p.passed !== "boolean") throw new DomainValidationError("依据核查结果 passed 必须是布尔值");
    const issues = strs(p.issues, "依据核查结果.issues");
    if(p.passed && issues.length)throw new DomainValidationError("核查通过时不能携带未解决问题");
    return {passed:p.passed,issues};
  }
  private snapshot(project: PrdProject, feature: Feature) {
    const current = project.features.find((x) => x.id === feature.id)!;
    return {
      feature: current,
      requirements: project.requirements.filter((x) =>
        current.requirementIds.includes(x.id),
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
