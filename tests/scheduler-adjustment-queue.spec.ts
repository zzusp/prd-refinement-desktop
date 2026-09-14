import { readFile, rm, writeFile } from "node:fs/promises";
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
const project = (): PrdProject => ({
  id: "P",
  name: "PRD",
  sourceName: "prd.md",
  sourceHash: "H",
  revision: 1,
  importedAt: "now",
  rawText: "用户可以提交订单。",
  stage: "review",
  sourceUnits: [
    {
      id: "S1",
      label: "S1",
      kind: "paragraph",
      excerpt: "用户可以提交订单。",
      location: "正文",
      status: "processed",
    },
  ],
  features: [
    {
      id: "F1",
      name: "提交订单",
      sourceUnitIds: ["S1"],
      sourceRefs: [{ sourceUnitId: "S1" }],
      ruleIds: [],
      requirementIds: ["R1"],
      state: "reviewed",
    },
  ],
  requirements: [
    {
      id: "R1",
      title: "提交",
      behavior: "用户可以提交订单",
      conditions: [],
      constraints: [],
      explicitAcceptanceConditions: [],
      sourceUnitIds: ["S1"],
      evidenceBindings: {
        behavior: [{ sourceUnitId: "S1" }],
        conditions: [],
        constraints: [],
        explicitAcceptanceConditions: [],
      },
      ruleIds: [],
      state: "reviewed",
    },
  ],
  clarifications: [],
  delivery: {
    state: "ready",
    inputHash: "H",
    resultHash: "RH",
    issueIds: [],
    unverifiedScopeIds: [],
    policyVersion: 2,
  },
});
const task = (
  id: string,
  version: number,
  createdAt = version,
): AnalysisTask => ({
  id,
  rootTaskId: "T-ROOT",
  resultVersion: version,
  project: project(),
  runtimeConfig: { ...config, credentialRef: "system-runtime-config" },
  attempt: 1,
  status: "completed",
  progress: 100,
  createdAt,
  completedAt: createdAt,
  steps: [],
  checkpoint: {pipelineVersion:27,resultVersion:1,promptMetrics:[],detailedFeatureIds:[],auditIssues:[],validationFailures:[]},
});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const root = async () => { const directory = await createTestWorkspace("prd-adjustment-queue"); roots.push(directory); return directory; };
const save = (directory: string, value: AnalysisTask) =>
  writeFile(
    path.join(directory, `${value.id}.json`),
    JSON.stringify(value),
    "utf8",
  );

describe("调整任务队列和版本基准", () => {
  it("相同 operationId 幂等，并在模型调用前持久化原始输入", async () => {
    const directory = await root();
    await save(directory, task("T-BASE", 1));
    const scheduler = new AnalysisTaskScheduler(
      directory,
      async () => config,
      () => {},
      () => {
        throw new Error("测试不启动模型");
      },
    );
    await scheduler.initialize();
    const request = {
      operationId: "OP-1",
      baseTaskId: "T-BASE",
      baseVersion: 1,
      feedback: "提交订单展开细化",
    };
    const first = await scheduler.enqueueAdjustment(request),
      second = await scheduler.enqueueAdjustment(request);
    expect(second.id).toBe(first.id);
    expect(first.resultVersion).toBeUndefined();
    expect(first.status).toBe("queued");
    const stored = JSON.parse(
      await readFile(path.join(directory, `${first.id}.json`), "utf8"),
    ) as AnalysisTask;
    expect(stored.operationId).toBe("OP-1");
    expect(stored.baseResultVersion).toBe(1);
    expect(stored.adjustment?.feedback).toBe("提交订单展开细化");
    expect(stored.project.userEvidence).toBeUndefined();
    await scheduler.cancel(first.id);
  });

  it("只允许基于任务族当前正式版本入队", async () => {
    const directory = await root();
    await save(directory, task("T-BASE", 1, 1));
    await save(directory, task("T-LATEST", 2, 2));
    const scheduler = new AnalysisTaskScheduler(
      directory,
      async () => config,
      () => {},
      () => {
        throw new Error("测试不启动模型");
      },
    );
    await scheduler.initialize();
    await expect(
      scheduler.enqueueAdjustment({
        operationId: "OP-STALE",
        baseTaskId: "T-BASE",
        baseVersion: 1,
        feedback: "提交订单精简",
      }),
    ).rejects.toThrow("最新版");
  });
  it("拒绝旧版建议采纳进入仅清单调整流程",async()=>{
    const directory=await root(),base=task('T-BASE',1);base.project.clarifications=[{id:'Q-1',question:'超时多久？',reason:'原文未明确',level:'blocking',knownFacts:'存在超时',unresolvedPoint:'时长',impact:'无法实现',levelReason:'影响业务行为',sourceRefs:[{sourceUnitId:'S1'}],affectedIds:['R1'],state:'open',resolutionProposal:{recommendation:'超时时长设为 30 分钟。',rationale:'沿用当前处理周期。',impact:'等待时间较长。',confirmation:'确认超时时长。',alternatives:[],sourceRefs:[{sourceUnitId:'S1'}]}}];await save(directory,base);
    const scheduler=new AnalysisTaskScheduler(directory,async()=>config,()=>{},()=>{throw new Error('测试不启动模型')});await scheduler.initialize();
    await expect(scheduler.enqueueAdjustment({operationId:'OP-EDIT',baseTaskId:'T-BASE',baseVersion:1,feedback:'超时时长改为 15 分钟。',acceptedProposals:[{clarificationId:'Q-1',baseRecommendation:'超时时长设为 30 分钟。',finalText:'超时时长改为 15 分钟。'}]})).rejects.toThrow('仅支持功能与需求清单调整');
  });
});
