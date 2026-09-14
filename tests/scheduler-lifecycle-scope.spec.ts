import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisTaskScheduler } from "../electron/scheduler-v2";
import type { AnalysisTask, PrdProject, RuntimeConfig } from "../src/types";
import { createTestWorkspace } from "./test-workspace";

const config: RuntimeConfig = {
  adapter: "codex-oauth",
  provider: "openai",
  model: "test",
  reasoningEffort: "low",
  maxParallel: 1,
  maxNodeParallel: 1,
};
const project = (snapshot?: string): PrdProject => ({
  id: "P",
  name: "订单",
  sourceName: "prd.md",
  sourceHash: "H",
  revision: 1,
  importedAt: "now",
  rawText: "提交订单",
  stage: "review",
  inputSnapshotPath: snapshot,
  sourceUnits: [
    {
      id: "S1",
      label: "正文",
      kind: "paragraph",
      excerpt: "提交订单",
      location: "正文",
      status: "processed",
    },
  ],
  features: [
    {
      id: "F1",
      name: "提交订单",
      sourceUnitIds: ["S1"],
      ruleIds: [],
      requirementIds: ["R1", "R2"],
      state: "reviewed",
    },
  ],
  requirements: [
    {
      id: "R1",
      title: "提交",
      behavior: "提交订单",
      conditions: [],
      constraints: [],
      explicitAcceptanceConditions: [],
      sourceUnitIds: ["S1"],
      ruleIds: [],
      state: "reviewed",
    },
    {
      id: "R2",
      title: "校验",
      behavior: "校验订单",
      conditions: [],
      constraints: [],
      explicitAcceptanceConditions: [],
      sourceUnitIds: ["S1"],
      ruleIds: [],
      state: "reviewed",
    },
  ],
  clarifications: [],
});
const task = (
  id: string,
  version?: number,
  parentTaskId?: string,
  snapshot?: string,
): AnalysisTask => ({
  id,
  rootTaskId: "T-ROOT",
  parentTaskId,
  resultVersion: version,
  project: project(snapshot),
  runtimeConfig: { ...config, credentialRef: "system-runtime-config" },
  attempt: 1,
  status: "completed",
  progress: 100,
  createdAt: version ?? 1,
  completedAt: version ?? 1,
  steps: [],
});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const setup = async (tasks: AnalysisTask[]) => {
  const root = await createTestWorkspace("prd-lifecycle"); roots.push(root);
  for (const value of tasks)
    await writeFile(
      path.join(root, `${value.id}.json`),
      JSON.stringify(value),
      "utf8",
    );
  const scheduler = new AnalysisTaskScheduler(
    root,
    async () => config,
    () => {},
    () => {
      throw new Error("测试不启动模型");
    },
  );
  await scheduler.initialize();
  return { root, scheduler };
};

describe("任务生命周期、本期范围与产物记录", () => {
  it("归档和恢复以整个任务族为单位，默认列表排除归档任务", async () => {
    const { scheduler } = await setup([task("T-1", 1), task("T-2", 2, "T-1")]);
    await scheduler.archiveFamily("T-2");
    expect(scheduler.list()).toEqual([]);
    expect(
      scheduler
        .listArchived()
        .map((x) => x.id)
        .sort(),
    ).toEqual(["T-1", "T-2"]);
    await scheduler.restoreFamily("T-1");
    expect(
      scheduler
        .list()
        .map((x) => x.id)
        .sort(),
    ).toEqual(["T-1", "T-2"]);
    expect(scheduler.listArchived()).toEqual([]);
  });

  it("运行中的任务先失效执行尝试并等待 runtime 停止，再归档任务族", async () => {
    const { scheduler } = await setup([task("T-1", 1)]);
    const live = (scheduler as any).tasks.get("T-1") as AnalysisTask;
    live.status = "running";
    let stopped = false;
    (scheduler as any).running.set("T-1", [{ stop: async () => { await Promise.resolve(); stopped = true; }, metrics: () => [] }]);
    const attempt = live.attempt;
    await scheduler.archiveFamily("T-1");
    expect(stopped).toBe(true);
    expect(live.attempt).toBe(attempt + 1);
    expect(live.status).toBe("failed");
    expect(scheduler.list()).toEqual([]);
    expect(scheduler.listArchived()).toHaveLength(1);
  });

  it("删除整族只清理托管任务和无人引用快照，迟到发布不能复活，也不删除资料包或用户原文件", async () => {
    const root = await createTestWorkspace("prd-delete"); roots.push(root);
    const
      snapshot = path.join(root, "input-snapshots", "S"),
      bundle = path.join(root, "material-bundles", "B"),
      original = path.join(root, "user-prd.md");
    await mkdir(snapshot, { recursive: true });
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(snapshot, "copy.md"), "copy");
    await writeFile(path.join(bundle, "bundle.json"), "bundle");
    await writeFile(original, "original");
    const value = task("T-1", 1, undefined, snapshot);
    await writeFile(path.join(root, "T-1.json"), JSON.stringify(value));
    await mkdir(path.join(root, "T-1", "result"), { recursive: true });
    const scheduler = new AnalysisTaskScheduler(
      root,
      async () => config,
      () => {},
      () => {
        throw new Error("测试不启动模型");
      },
    );
    await scheduler.initialize();
    const late = (scheduler as any).tasks.get("T-1") as AnalysisTask;
    await scheduler.deleteFamily("T-1");
    late.error = "迟到回调";
    await (scheduler as any).publish(late);
    expect(scheduler.get("T-1")).toBeUndefined();
    await expect(stat(path.join(root, "T-1.json"))).rejects.toThrow();
    await expect(stat(snapshot)).rejects.toThrow();
    expect(await readFile(path.join(bundle, "bundle.json"), "utf8")).toBe(
      "bundle",
    );
    expect(await readFile(original, "utf8")).toBe("original");
  });

  it("批量范围更新生成新版本，功能级决定写入功能和全部需求并保护旧版本", async () => {
    const { scheduler } = await setup([task("T-1", 1)]);
    const changed = await scheduler.updateDeliveryScope({
      operationId: "SCOPE-1",
      baseTaskId: "T-1",
      baseVersion: 1,
      scope: "excluded",
      targets: [{ kind: "feature", id: "F1" }],
    });
    expect(changed.resultVersion).toBe(2);
    expect(changed.project.features[0].deliveryScope).toBe("excluded");
    expect(
      changed.project.requirements.every((x) => x.deliveryScope === "excluded"),
    ).toBe(true);
    expect(changed.project.delivery?.inputHash).not.toBe("H");
    expect(changed.checkpoint?.checks).toBeDefined();
    expect(
      (
        await scheduler.updateDeliveryScope({
          operationId: "SCOPE-1",
          baseTaskId: "T-1",
          baseVersion: 1,
          scope: "excluded",
          targets: [{ kind: "feature", id: "F1" }],
        })
      ).id,
    ).toBe(changed.id);
    await expect(
      scheduler.updateDeliveryScope({
        baseTaskId: "T-1",
        baseVersion: 1,
        scope: "current",
        targets: [{ kind: "requirement", id: "R1" }],
      }),
    ).rejects.toThrow("最新版");
  });

  it("旧任务只有真实完成结果才补版本，产物目录缺失会如实返回 exists=false", async () => {
    const unfinished = {
        ...task("T-U"),
        status: "failed" as const,
        project: { ...project(), features: [], requirements: [] },
      },
      formed = task("T-F");
    formed.rootTaskId = "T-F";
    const { root, scheduler } = await setup([unfinished, formed]);
    expect(scheduler.get("T-U")?.resultVersion).toBeUndefined();
    expect(scheduler.get("T-F")?.resultVersion).toBe(1);
    const missing = path.join(root, "missing");
    await scheduler.recordArtifact("T-F", {
      kind: "agent-package",
      path: missing,
      resultVersion: 1,
    });
    expect(await scheduler.queryArtifacts("T-F")).toMatchObject([
      { path: missing, exists: false, resultVersion: 1 },
    ]);
  });
  it("阻塞事项建议按统一预算记录提示词、运行状态和 Runtime 指标",async()=>{
    const base=task("T-P",1);base.status="needs-attention";base.project.clarifications=[{id:"Q1",question:"超时时间是多少？",reason:"原文未明确",level:"blocking",knownFacts:"存在超时",unresolvedPoint:"时长",impact:"影响状态流转",levelReason:"Agent 不能猜测",sourceRefs:[{sourceUnitId:"S1"}],affectedIds:["R1"],state:"open"}];
    const directory=await createTestWorkspace("prd-proposal");roots.push(directory);await writeFile(path.join(directory,"T-P.json"),JSON.stringify(base),"utf8");
    const scheduler=new AnalysisTaskScheduler(directory,async()=>config,()=>{},()=>({start:async()=>{},stop:async()=>{},diagnostics:()=>"",metrics:()=>[{sessionId:"prd-T-P-proposal-1-try1",adapter:"codex-oauth",model:"test",reasoningEffort:"low",startedAt:1,completedAt:2,durationMs:1,inputTokens:20,outputTokens:5}],executeOperation:async()=>({completion:'completed',value:{proposals:[{clarificationId:"Q1",recommendation:"超时时长统一设为三十分钟。",rationale:"当前材料明确存在超时控制。",impact:"到期后进入超时状态。",confirmation:"确认采用三十分钟。",alternatives:[],evidenceIds:["S1"]}]}}),promptAndWait:async()=>{throw new Error('不得走自由文本入口')}}));
    await scheduler.initialize();const result=await scheduler.generateResolutionProposals("T-P");
    expect(result.proposalGeneration).toMatchObject({status:"completed",calls:1});expect(result.checkpoint?.promptMetrics).toHaveLength(1);expect(result.runtimeMetrics).toHaveLength(1);expect(result.project.clarifications[0].resolutionProposal?.recommendation).toContain("三十分钟");
  });
});
