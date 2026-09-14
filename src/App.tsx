import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  FolderOpen,
  Gauge,
  ListChecks,
  Microscope,
  MoreHorizontal,
  PackageOpen,
  Plus,
  RotateCw,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type {
  AnalysisStep,
  AnalysisTask,
  DeliveryScopeUpdateRequest,
  ModelNodeId,
  ModelProfile,
  RefinementAdjustmentRequest,
  RuntimeConfig,
  RuntimeStatus,
  PrdProject,
  RequirementDetail,
  TaskArtifact,
} from "./types";
import { MaterialWorkspace } from "./MaterialWorkspace";
import { ResultIssues } from "./ResultIssues";
import {
  clarificationCounts,
  featureTitle,
  readableContext,
  requirementSourceRefs,
  sourceExcerpt,
  sourceHeading,
  sourcePosition,
} from "./result-presentation";

const stepDefs = [
  ["inventory", "原文建账", "登记原文、结构、位置与缺失材料"],
  ["candidates", "功能候选识别", "按连贯原文包并行识别功能候选"],
  ["unify", "功能清单整理", "去重并统一功能边界与来源"],
  ["details", "逐功能细化", "逐项整理需求、条件与待澄清内容"],
  ["audit", "产物依据核查", "核查已有主张是否受来源支持"],
  ["repair", "有据修正", "仅修正已确认的无依据或误读内容"],
  ["delivery", "结果发布", "校验最终快照并生成 Agent 需求包"],
];
const modelNodes: [ModelNodeId, string, string][] = [
  ["imageReading", "图片内容读取", "按需转录图片、图表和页面内容"],
  ["inputInterpretation", "补充说明理解", "区分业务补充、范围决定、整理要求和待回答问题"],
  ["featureCandidates", "功能候选识别", "按连贯候选内容快速识别候选"],
  ["featureCandidateRepair", "候选定点返工", "根据边界问题修订受影响候选内容"],
  ["featureGlobal", "功能清单整理", "处理语义重叠和边界争议"],
  ["detailsFast", "简单功能细化", "整理短小、无复杂联动的功能"],
  ["details", "复杂功能细化", "处理状态、权限、依赖和复杂条件"],
  ["audit", "产物依据核查", "核查已有主张是否受来源支持"],
  ["repair", "有据修正", "只处理已确认的无依据或误读内容"],
];
const defaultNodeProfiles = (
  adapter: RuntimeConfig["adapter"],
): Record<ModelNodeId, ModelProfile> => {
  const fast = adapter === "codex-oauth" ? "gpt-5.6-luna" : "deepseek-v4-flash",
    critical = adapter === "codex-oauth" ? "gpt-5.6-sol" : "deepseek-v4",
    standard = adapter === "codex-oauth" ? "gpt-5.6-terra" : "deepseek-v4";
  return {
    imageReading: { model: fast, reasoningEffort: "low" },
    inputInterpretation: { model: fast, reasoningEffort: "low" },
    featureCandidates: { model: fast, reasoningEffort: "low" },
    featureCandidateRepair: { model: standard, reasoningEffort: "low" },
    featureGlobal: { model: standard, reasoningEffort: "low" },
    detailsFast: { model: fast, reasoningEffort: "low" },
    details: { model: standard, reasoningEffort: "low" },
    audit: { model: critical, reasoningEffort: "low" },
    repair: { model: standard, reasoningEffort: "low" },
  };
};
const stepModelNodes: Record<
  string,
  Array<{ node: ModelNodeId; label: string; purpose: string }>
> = {
  inventory: [
    {
      node: "imageReading",
      label: "图片转录",
      purpose: "仅在候选内容含图片时调用",
    },
    {
      node: "inputInterpretation",
      label: "补充说明理解",
      purpose: "仅在本次分析填写补充说明时调用",
    },
  ],
  candidates: [
    {
      node: "featureCandidates",
      label: "首次识别",
      purpose: "逐份候选内容提取功能候选",
    },
    {
      node: "featureCandidateRepair",
      label: "定点返工",
      purpose: "只修订边界或分类问题",
    },
  ],
  unify: [
    {
      node: "featureGlobal",
      label: "跨候选统一",
      purpose: "合并重复候选并统一功能边界",
    },
  ],
  details: [
    {
      node: "detailsFast",
      label: "简单功能细化",
      purpose: "处理短小且无复杂联动的功能",
    },
    {
      node: "details",
      label: "复杂功能细化",
      purpose: "处理状态、权限、依赖和例外",
    },
  ],
  audit: [
    {
      node: "audit",
      label: "依据核查",
      purpose: "核查已有主张、条件和澄清是否受依据支持",
    },
  ],
  repair: [
    {
      node: "repair",
      label: "有据修正",
      purpose: "只修改已确认的无依据或误读内容",
    },
  ],
  delivery: [],
};
const fastModelNodes = new Set<ModelNodeId>([
  "imageReading",
  "featureCandidates",
  "detailsFast",
]);
const reasoningLabels: Record<RuntimeConfig["reasoningEffort"], string> = {
  default: "模型默认",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "XHigh",
  max: "Max",
  ultra: "Ultra",
};
function taskNodeProfile(
  task: AnalysisTask,
  node: ModelNodeId,
): ModelProfile | undefined {
  const config = task.runtimeConfig;
  if (!config) return undefined;
  const configured = config.nodeProfiles?.[node];
  return {
    model:
      configured?.model ??
      (fastModelNodes.has(node)
        ? (config.fastModel ?? config.model)
        : config.model),
    reasoningEffort:
      configured?.reasoningEffort ??
      (fastModelNodes.has(node)
        ? (config.fastReasoningEffort ?? "low")
        : config.reasoningEffort),
  };
}
function stepRuntimeItems(task: AnalysisTask, stepId: string) {
  return (stepModelNodes[stepId] ?? []).map((item) => {
    const profile = taskNodeProfile(task, item.node);
    return { ...item, profile };
  });
}
function stepDisplayNote(note: string) {
  return note.replaceAll("来源包", "候选内容");
}
type Page = "tasks" | "upload" | "task" | "settings";
type ResultTab = "features" | "requirements" | "issues" | "execution";
type AdjustmentRequest = RefinementAdjustmentRequest;
function taskRootId(task: AnalysisTask) {
  return task.rootTaskId ?? task.id;
}
function taskVersion(task: AnalysisTask) {
  return task.resultVersion ?? 1;
}
export function displayProgress(value: number) {
  return Math.round(Math.max(0, Math.min(100, value)));
}
export function artifactRefreshKey(task: AnalysisTask) {
  return `${task.id}:${task.resultVersion ?? 0}:${task.artifacts?.length ?? 0}`;
}
const taskStatusLabel = (task: AnalysisTask) =>
  task.status === "needs-attention"
    ? "已完成"
    : {
        queued: "排队中",
        running: "执行中",
        completed: "已完成",
        failed: "执行失败",
      }[task.status];
function elapsed(start?: number, end?: number, now = Date.now()) {
  if (start === undefined) return "—";
  const seconds = Math.max(0, Math.floor(((end ?? now) - start) / 1000));
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
export function runtimeTiming(task: AnalysisTask) {
  const calls = [...(task.runtimeMetrics ?? [])].sort(
      (a, b) => a.startedAt - b.startedAt,
    ),
    attempts = new Map<number, { start: number; end: number }>();
  let active = 0,
    end = 0;
  for (const call of calls) {
    if (call.startedAt > end)
      active += Math.max(0, call.completedAt - call.startedAt);
    else if (call.completedAt > end) active += call.completedAt - end;
    end = Math.max(end, call.completedAt);
    const match = call.sessionId.match(/-a(\d+)-/),
      attempt = match ? Number(match[1]) : 0,
      current = attempts.get(attempt);
    attempts.set(attempt, {
      start: Math.min(current?.start ?? call.startedAt, call.startedAt),
      end: Math.max(current?.end ?? call.completedAt, call.completedAt),
    });
  }
  const ranges = [...attempts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, range]) => range);
  let retryWait = 0;
  for (let i = 1; i < ranges.length; i++)
    retryWait += Math.max(0, ranges[i].start - ranges[i - 1].end);
  return { active, retryWait };
}

export function App() {
  const [tasks, setTasks] = useState<AnalysisTask[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<AnalysisTask[]>([]);
  const [page, setPage] = useState<Page>("tasks");
  const [activeId, setActiveId] = useState("");
  const [now, setNow] = useState(Date.now());
  const [harness, setHarness] = useState<RuntimeStatus>({
    available: false,
    reason: "正在检测",
  });
  useEffect(() => {
    if (!window.prdApp) return;
    void Promise.all([
      window.prdApp.inspectRuntime(),
      window.prdApp.loadAnalysisTasks(),
      window.prdApp.loadArchivedAnalysisTasks(),
    ]).then(([runtime, saved, archived]) => {
      setHarness(runtime);
      setTasks(saved);
      setArchivedTasks(archived);
      if (saved[0]) setActiveId(saved[0].id);
    });
    return window.prdApp.onAnalysisTaskUpdate((updated) => {
      if (updated.archivedAt) {
        setArchivedTasks((current) => [
          updated,
          ...current.filter((task) => task.id !== updated.id),
        ]);
        setTasks((current) => current.filter((task) => task.id !== updated.id));
      } else {
        setTasks((current) => [
          updated,
          ...current.filter((task) => task.id !== updated.id),
        ]);
        setArchivedTasks((current) =>
          current.filter((task) => task.id !== updated.id),
        );
      }
    });
  }, []);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (window.prdApp) return;
    const id = setInterval(
      () => setTasks((current) => current.map((task) => advance(task))),
      1000,
    );
    return () => clearInterval(id);
  }, []);
  function openTask(id: string) {
    setActiveId(id);
    setPage("task");
  }
  async function adjust(request: AdjustmentRequest) {
    const updated = await window.prdApp.adjustAnalysis(request);
    setTasks((current) => [
      updated,
      ...current.filter((task) => task.id !== updated.id),
    ]);
    setActiveId(updated.id);
  }
  async function updateScope(request: DeliveryScopeUpdateRequest) {
    const updated = await window.prdApp.updateDeliveryScope(request);
    setTasks((current) => [
      updated,
      ...current.filter((task) => task.id !== updated.id),
    ]);
    setActiveId(updated.id);
  }
  async function retry(task: AnalysisTask) {
    await window.prdApp.retryAnalysis(task.id);
  }
  async function restart(task: AnalysisTask) {
    const created = await window.prdApp.restartAnalysis(task.id);
    setTasks((current) => [created, ...current.filter((item) => item.id !== created.id)]);
    setActiveId(created.id);
  }
  async function archive(task: AnalysisTask) {
    await window.prdApp.archiveAnalysisTask(taskRootId(task));
    const family = tasks.filter(
      (item) => taskRootId(item) === taskRootId(task),
    );
    setTasks((current) =>
      current.filter((item) => taskRootId(item) !== taskRootId(task)),
    );
    setArchivedTasks((current) => [
      ...family,
      ...current.filter((item) => taskRootId(item) !== taskRootId(task)),
    ]);
    setPage("tasks");
  }
  async function restore(task: AnalysisTask) {
    await window.prdApp.restoreAnalysisTask(taskRootId(task));
    const family = archivedTasks
      .filter((item) => taskRootId(item) === taskRootId(task))
      .map((item) => ({ ...item, archivedAt: undefined }));
    setArchivedTasks((current) =>
      current.filter((item) => taskRootId(item) !== taskRootId(task)),
    );
    setTasks((current) => [
      ...family,
      ...current.filter((item) => taskRootId(item) !== taskRootId(task)),
    ]);
    setPage("tasks");
  }
  async function remove(task: AnalysisTask) {
    await window.prdApp.deleteAnalysisTask(taskRootId(task));
    setTasks((current) =>
      current.filter((item) => taskRootId(item) !== taskRootId(task)),
    );
    setArchivedTasks((current) =>
      current.filter((item) => taskRootId(item) !== taskRootId(task)),
    );
    clearFeedbackDraft(
      feedbackStorage(),
      `prd-feedback-draft:${taskRootId(task)}`,
    );
    setPage("tasks");
  }
  const allTasks = [...tasks, ...archivedTasks],
    active = allTasks.find((t) => t.id === activeId);
  const versions = active
    ? allTasks
        .filter((task) => taskRootId(task) === taskRootId(active))
        .sort((a, b) => taskVersion(b) - taskVersion(a))
    : [];
  return (
    <main className="platform">
      <TopBar page={page} setPage={setPage} harness={harness} />
      {page === "tasks" ? (
        <TaskCenter
          tasks={tasks}
          archivedTasks={archivedTasks}
          now={now}
          onOpen={openTask}
          onNew={() => setPage("upload")}
          onArchive={archive}
          onRestore={restore}
          onDelete={remove}
        />
      ) : page === "upload" ? (
        <MaterialWorkspace
          onStarted={(task) => {
            setTasks((c) => [task, ...c.filter((x) => x.id !== task.id)]);
            setActiveId(task.id);
            setPage("task");
          }}
          onBack={() => setPage("tasks")}
        />
      ) : page === "settings" ? (
        <RuntimeSettings status={harness} onStatus={setHarness} />
      ) : active ? (
        <TaskPage
          task={active}
          versions={versions}
          now={now}
          onBack={() => setPage("tasks")}
          onVersion={setActiveId}
          onAdjust={adjust}
          onScope={updateScope}
          onRetry={retry}
          onRestart={restart}
          onArchive={archive}
          onRestore={restore}
          onDelete={remove}
        />
      ) : null}
    </main>
  );
}
function advance(task: AnalysisTask): AnalysisTask {
  if (task.status !== "running") return task;
  const progress = Math.min(100, task.progress + 2);
  const stage = Math.min(4, Math.floor(progress / 20));
  const now = Date.now();
  const steps = task.steps.map((s, i): AnalysisStep =>
    i < stage
      ? { ...s, status: "completed", completedAt: s.completedAt ?? now }
      : i === stage && progress < 100
        ? { ...s, status: "running", startedAt: s.startedAt ?? now }
        : {
            ...s,
            status: i === stage ? "completed" : "pending",
            completedAt: i === stage ? now : s.completedAt,
          },
  );
  if (progress === 100) {
    void window.prdApp?.prepareResult(task.project);
    return { ...task, progress, status: "completed", completedAt: now, steps };
  }
  return { ...task, progress, steps };
}

function TopBar({
  page,
  setPage,
  harness,
}: {
  page: Page;
  setPage: (p: Page) => void;
  harness: RuntimeStatus;
}) {
  const name = harness.adapter === "dsh" ? "DeepSeek Harness" : "Codex CLI";
  const label = harness.routeReady
    ? `${name} ${harness.version}`
    : harness.available
      ? `${name} 已安装`
      : "Runtime 未连接";
  return (
    <header className="platform-bar">
      <button className="logo" onClick={() => setPage("tasks")}>
        <Microscope />
        <strong>需求细化平台</strong>
      </button>
      <nav>
        <button
          className={page !== "settings" ? "active" : ""}
          onClick={() => setPage("tasks")}
        >
          <ListChecks />
          任务
        </button>
        <button
          className={page === "settings" ? "active" : ""}
          onClick={() => setPage("settings")}
        >
          <Settings />
          Runtime 配置
        </button>
      </nav>
      <div className={harness.routeReady ? "runtime ready" : "runtime"}>
        <i />
        <span>{label}</span>
      </div>
    </header>
  );
}
function latestFamilies(tasks: AnalysisTask[]) {
  return [...tasks]
    .sort(
      (a, b) => taskVersion(b) - taskVersion(a) || b.createdAt - a.createdAt,
    )
    .filter(
      (task, index, all) =>
        all.findIndex((item) => taskRootId(item) === taskRootId(task)) ===
        index,
    );
}
function TaskCenter({
  tasks,
  archivedTasks,
  now,
  onOpen,
  onNew,
  onArchive,
  onRestore,
  onDelete,
}: {
  tasks: AnalysisTask[];
  archivedTasks: AnalysisTask[];
  now: number;
  onOpen: (id: string) => void;
  onNew: () => void;
  onArchive: (task: AnalysisTask) => Promise<void>;
  onRestore: (task: AnalysisTask) => Promise<void>;
  onDelete: (task: AnalysisTask) => Promise<void>;
}) {
  const [view, setView] = useState<"current" | "archived">("current"),
    current = latestFamilies(tasks),
    archived = latestFamilies(archivedTasks),
    rows = view === "current" ? current : archived,
    source = view === "current" ? tasks : archivedTasks,
    running = current.filter(
      (t) => t.status === "running" || t.status === "queued",
    ).length;
  return (
    <div className="page task-center">
      <div className="page-title">
        <div>
          <span>任务中心</span>
          <h1>需求分析任务</h1>
          <p>任务保留全部结果版本；归档任务可随时恢复。</p>
        </div>
        <button className="primary" onClick={onNew}>
          <Plus />
          新建任务
        </button>
      </div>
      <div className="task-center-tabs" aria-label="任务列表">
        <button
          aria-pressed={view === "current"}
          className={view === "current" ? "active" : ""}
          onClick={() => setView("current")}
        >
          当前任务 <b>{current.length}</b>
        </button>
        <button
          aria-pressed={view === "archived"}
          className={view === "archived" ? "active" : ""}
          onClick={() => setView("archived")}
        >
          已归档 <b>{archived.length}</b>
        </button>
        <span>
          {running > 0 ? `${running} 个任务正在执行` : "当前没有执行中的任务"}
        </span>
      </div>
      <section className="collection task-collection">
        <div className="task-table">
          <div className="thead">
            <span>任务</span>
            <span>状态</span>
            <span>当前阶段</span>
            <span>进度</span>
            <span>墙钟耗时</span>
            <span>创建时间</span>
            <span>操作</span>
          </div>
          {rows.length === 0 ? (
            <div className="task-empty">
              <ListChecks />
              <strong>
                {view === "current" ? "还没有需求分析任务" : "没有已归档任务"}
              </strong>
              <span>
                {view === "current"
                  ? "选择一份主 PRD，开始第一次需求细化。"
                  : "归档后的任务会完整保留在这里。"}
              </span>
              {view === "current" && (
                <button className="secondary" onClick={onNew}>
                  新建任务
                </button>
              )}
            </div>
          ) : (
            rows.map((task) => (
              <TaskCenterRow
                key={task.id}
                task={task}
                versions={
                  source.filter((item) => taskRootId(item) === taskRootId(task))
                    .length
                }
                now={now}
                archived={view === "archived"}
                onOpen={onOpen}
                onArchive={onArchive}
                onRestore={onRestore}
                onDelete={onDelete}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}
function TaskCenterRow({
  task,
  versions,
  now,
  archived,
  onOpen,
  onArchive,
  onRestore,
  onDelete,
}: {
  task: AnalysisTask;
  versions: number;
  now: number;
  archived: boolean;
  onOpen: (id: string) => void;
  onArchive: (task: AnalysisTask) => Promise<void>;
  onRestore: (task: AnalysisTask) => Promise<void>;
  onDelete: (task: AnalysisTask) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false),
    [error, setError] = useState(""),
    [managing, setManaging] = useState(false),
    step = task.steps.find((s) => s.status === "running") ?? task.steps.at(-1),
    busy = task.status === "running" || task.status === "queued";
  async function manage(action: "archive" | "restore") {
    setManaging(true);
    setError("");
    try {
      await (action === "archive" ? onArchive(task) : onRestore(task));
    } catch (value) {
      setError(
        value instanceof Error
          ? value.message
          : `${action === "archive" ? "归档" : "恢复"}失败，请重试。`,
      );
      setManaging(false);
    }
  }
  return (
    <div className="task-row task-row-managed">
      <button
        className="task-row-open"
        onClick={() => onOpen(task.id)}
        aria-label={`打开任务 ${task.id}：${task.project.name}`}
      />
      <span className="task-identity">
          <span className="task-primary-line">
            <code>{task.id}</code>
            <strong>{task.project.name}</strong>
          </span>
          <small>
            <FileText aria-hidden="true" />
            {task.project.sourceName} · 第 {taskVersion(task)} 版
          </small>
      </span>
      <em className={`task-status ${task.status}`}>
        {archived ? "已归档" : taskStatusLabel(task)}
      </em>
      <span className="task-stage">{step?.name}</span>
      <span
        className="mini-progress"
        role="progressbar"
        aria-label={`${task.project.name}进度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={displayProgress(task.progress)}
      >
        <i style={{ width: `${task.progress}%` }} />
        <b>{displayProgress(task.progress)}%</b>
      </span>
      <span className="task-time">
        {elapsed(task.requestedAt??task.startedAt, task.completedAt, now)}
      </span>
      <span className="task-time">
        {new Date(task.createdAt).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
      <details className="more-menu">
        <summary aria-label={`${task.project.name}更多操作`}>
          <MoreHorizontal />
        </summary>
        <div>
          {archived ? (
            <button disabled={managing} onClick={() => void manage("restore")}>
              <Undo2 />
              {managing ? "正在恢复" : "恢复任务"}
            </button>
          ) : (
            <button disabled={managing} onClick={() => void manage("archive")}>
              <Archive />
              {managing ? "正在归档" : busy ? "停止并归档" : "归档任务"}
            </button>
          )}
          <button
            className="danger-text"
            disabled={managing}
            onClick={() => setDeleting(true)}
          >
            <Trash2 />
            {busy ? "停止并删除" : "删除任务"}
          </button>
        </div>
      </details>
      {error && (
        <p className="row-error" role="alert">
          {error}
        </p>
      )}
      {deleting && (
        <DeleteTaskDialog
          task={task}
          versions={versions}
          onCancel={() => setDeleting(false)}
          onConfirm={() => onDelete(task)}
        />
      )}
    </div>
  );
}
function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function TaskPage({
  task,
  versions,
  now,
  onBack,
  onVersion,
  onAdjust,
  onScope,
  onRetry,
  onRestart,
  onArchive,
  onRestore,
  onDelete,
}: {
  task: AnalysisTask;
  versions: AnalysisTask[];
  now: number;
  onBack: () => void;
  onVersion: (id: string) => void;
  onAdjust: (request: AdjustmentRequest) => Promise<void>;
  onScope: (request: DeliveryScopeUpdateRequest) => Promise<void>;
  onRetry: (task: AnalysisTask) => Promise<void>;
  onRestart: (task: AnalysisTask) => Promise<void>;
  onArchive: (task: AnalysisTask) => Promise<void>;
  onRestore: (task: AnalysisTask) => Promise<void>;
  onDelete: (task: AnalysisTask) => Promise<void>;
}) {
  const [tab, setTab] = useState<ResultTab>(() =>
    task.status === "running" || task.status === "queued" || task.status === "failed"
      ? "execution"
      : "features",
  );
  const [detail, setDetail] = useState<RequirementDetail>();
  const [featureFilter, setFeatureFilter] = useState<string>();
  const [artifact, setArtifact] = useState<TaskArtifact>();
  const [artifactAction, setArtifactAction] = useState<"generate" | "open">();
  const [actionMessage, setActionMessage] = useState<{
    kind: "success" | "error";
    text: string;
  }>();
  const [deleting, setDeleting] = useState(false),
    [managing, setManaging] = useState(false);
  const [failureAction, setFailureAction] = useState<"retry" | "restart">();
  const [selectedProposalIds, setSelectedProposalIds] = useState<string[]>([]);
  const [proposalOverrides,setProposalOverrides]=useState<Record<string,string>>({});
  const proposalLoadedKey=useRef('');
  const [generatingProposals,setGeneratingProposals]=useState(false);
  const rootKey = taskRootId(task);
  const proposalStorageKey=`prd-proposal-overrides:${task.id}:${taskVersion(task)}`;
  const inScope = task.project.requirements.filter(
      (item) => item.deliveryScope !== "excluded",
    ).length,
    excluded = task.project.requirements.length - inScope,
    issues = clarificationCounts(task.project),
    issueCount =
      issues.blocking + issues.suggestion + issues.ignorable + issues.platform,
    canAdjust =
      !task.archivedAt &&
      (task.status === "completed" || task.status === "needs-attention"),
    busy = task.status === "running" || task.status === "queued";
  useEffect(() => {
    setTab(
      task.status === "running" || task.status === "queued" || task.status === "failed"
        ? "execution"
        : "features",
    );
    setFeatureFilter(undefined);
    setDetail(undefined);
    setSelectedProposalIds([]);
    setProposalOverrides({});
    setFailureAction(undefined);
  }, [rootKey]);
  useEffect(() => {
    if (task.status !== "failed") setFailureAction(undefined);
  }, [task.status]);
  useEffect(()=>{setSelectedProposalIds([]);try{const value=window.localStorage.getItem(proposalStorageKey);proposalLoadedKey.current=proposalStorageKey;setProposalOverrides(value?JSON.parse(value):{})}catch{proposalLoadedKey.current=proposalStorageKey;setProposalOverrides({})}},[proposalStorageKey]);
  useEffect(()=>{if(proposalLoadedKey.current!==proposalStorageKey)return;try{window.localStorage.setItem(proposalStorageKey,JSON.stringify(proposalOverrides))}catch{/* 本地存储不可用不阻断调整 */}},[proposalStorageKey,proposalOverrides]);
  useEffect(() => {
    let current = true;
    void window.prdApp
      .queryAnalysisArtifacts(task.id)
      .then((items) => {
        if (!current) return;
        setArtifact(
          items.find((item) => item.resultVersion === taskVersion(task) && item.exists),
        );
      })
      .catch((value) => {
        if (!current) return;
        setArtifact(undefined);
        setActionMessage({
          kind: "error",
          text:
            value instanceof Error
              ? value.message
              : "读取交付产物记录失败，请重试。",
        });
      });
    return () => { current = false; };
  }, [artifactRefreshKey(task)]);
  async function generate() {
    if (artifactAction) return;
    setArtifactAction("generate");
    setActionMessage(undefined);
    try {
      const created = await window.prdApp.exportAgentPackage(task.id);
      setArtifact(created);
      setActionMessage({
        kind: "success",
        text: `已生成第 ${created.resultVersion} 版交付包。`,
      });
    } catch (value) {
      setActionMessage({
        kind: "error",
        text:
          value instanceof Error ? value.message : "生成交付包失败，请重试。",
      });
    } finally {
      setArtifactAction(undefined);
    }
  }
  async function open() {
    if (artifactAction) return;
    setArtifactAction("open");
    setActionMessage(undefined);
    try {
      const result = await window.prdApp.openResultDirectory(task.id);
      if (!result.exists || result.error)
        throw new Error(result.error ?? "当前版本尚未生成交付包。");
      setActionMessage({
        kind: "success",
        text: "已打开当前版本的产物目录。",
      });
    } catch (value) {
      setActionMessage({
        kind: "error",
        text: value instanceof Error ? value.message : "打开产物失败，请重试。",
      });
    } finally {
      setArtifactAction(undefined);
    }
  }
  async function manage(action: "archive" | "restore") {
    setManaging(true);
    setActionMessage(undefined);
    try {
      await (action === "archive" ? onArchive(task) : onRestore(task));
    } catch (value) {
      setActionMessage({
        kind: "error",
        text:
          value instanceof Error
            ? value.message
            : `${action === "archive" ? "归档" : "恢复"}任务失败，请重试。`,
      });
      setManaging(false);
    }
  }
  async function recover(action: "retry" | "restart") {
    if (failureAction) return;
    setFailureAction(action);
    setActionMessage(undefined);
    try {
      await (action === "retry" ? onRetry(task) : onRestart(task));
    } catch (value) {
      setActionMessage({kind: "error", text: value instanceof Error ? value.message : `${action === "retry" ? "继续执行" : "重新开始"}失败，请重试。`});
      setFailureAction(undefined);
    }
  }
  async function generateProposals(){setGeneratingProposals(true);setActionMessage(undefined);try{await window.prdApp.generateResolutionProposals(task.id);setActionMessage({kind:'success',text:'阻塞事项的建议方案已生成。'})}catch(value){setActionMessage({kind:'error',text:value instanceof Error?value.message:'建议方案生成失败，请重试。'})}finally{setGeneratingProposals(false)}}
  return (
    <div className="page task-workspace">
      <button className="back" onClick={onBack}>
        返回任务中心
      </button>
      <header className="workspace-title">
        <div>
          <div className="workspace-name">
            <h1>{task.project.name}</h1>
            <label className="version-select">
              <span className="sr-only">结果版本</span>
              <select
                aria-label="结果版本"
                value={task.id}
                onChange={(event) => onVersion(event.target.value)}
              >
                {versions.map((item) => (
                  <option value={item.id} key={item.id}>
                    第 {taskVersion(item)} 版
                    {item.id === versions[0]?.id ? " · 最新" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p>{task.project.sourceName}</p>
        </div>
        <div className="workspace-actions">
          <button
            className="primary"
            disabled={
              !inScope ||
              artifactAction === "generate" ||
              busy ||
              !!task.archivedAt
            }
            aria-busy={artifactAction === "generate"}
            onClick={() => void generate()}
          >
            <PackageOpen />
            {artifactAction === "generate" ? "正在生成" : "生成交付包"}
          </button>
          <button
            className="secondary"
            disabled={!artifact || artifactAction === "open"}
            aria-busy={artifactAction === "open"}
            onClick={() => void open()}
          >
            <FolderOpen />
            {artifactAction === "open" ? "正在打开" : "打开产物"}
          </button>
          <details className="more-menu">
            <summary aria-label="更多任务操作">
              <MoreHorizontal />
              更多
            </summary>
            <div>
              {task.archivedAt ? (
                <button
                  disabled={managing}
                  onClick={() => void manage("restore")}
                >
                  <Undo2 />
                  {managing ? "正在恢复" : "恢复任务"}
                </button>
              ) : (
                <button
                  disabled={managing}
                  onClick={() => void manage("archive")}
                >
                  <Archive />
                  {managing ? "正在归档" : busy ? "停止并归档" : "归档任务"}
                </button>
              )}
              <button
                className="danger-text"
                disabled={managing}
                onClick={() => setDeleting(true)}
              >
                <Trash2 />
                {busy ? "停止并删除" : "删除任务"}
              </button>
            </div>
          </details>
        </div>
      </header>
      <div className="workspace-summary">
        <em className={`task-status ${task.status}`}>
          {task.archivedAt ? "已归档" : taskStatusLabel(task)}
        </em>
        <span>本期 {inScope} 条</span>
        <span>本期不做 {excluded} 条</span>
        <span>待处理 {issueCount} 项</span>
        <details>
          <summary>耗时/用量</summary>
          <RuntimeCost task={task} />
        </details>
      </div>
      {actionMessage && (
        <p
          className={`workspace-message ${actionMessage.kind}`}
          role={actionMessage.kind === "error" ? "alert" : "status"}
        >
          {actionMessage.text}
        </p>
      )}
      <Results
        task={task}
        project={task.project}
        tab={tab}
        setTab={setTab}
        featureFilter={featureFilter}
        setFeatureFilter={setFeatureFilter}
        onDetail={setDetail}
        onScope={onScope}
        selectedProposalIds={selectedProposalIds}
        onProposalSelection={setSelectedProposalIds}
        proposalOverrides={proposalOverrides}
        onProposalOverride={(id,value)=>setProposalOverrides(current=>{const next={...current};if(value)next[id]=value;else delete next[id];return next})}
        onGenerateProposals={()=>void generateProposals()}
        generatingProposals={generatingProposals}
        failureAction={failureAction}
        onRecover={(action) => void recover(action)}
        now={now}
      />
      {task.project.analysisInput?.text&&<details className="task-input-summary"><summary>本次分析输入 <span>用户补充 · {task.project.analysisInput.text.length.toLocaleString('zh-CN')} 字</span></summary><div><small>提交于 {new Date(task.project.analysisInput.submittedAt).toLocaleString('zh-CN')} · 已随第 {task.project.analysisInput.revision} 版输入固定</small><pre>{task.project.analysisInput.text}</pre>{task.project.analysisInputApplications?.length?<section className="input-application-list"><h4>平台如何使用这些内容</h4>{task.project.analysisInputApplications.map(item=><article key={item.sourceUnitId}><strong>{item.kind==='business-fact'?'业务补充':item.kind==='scope-decision'?'本期范围':item.kind==='organization'?'整理要求':item.kind==='question'?'待回答问题':'替换口径'}</strong><span>{item.summary}</span><em>{item.status==='pending'?'仍待确认':item.affectedFeatureIds.length?`已应用到 ${item.affectedFeatureIds.length} 个功能`:'已记录'}</em></article>)}</section>:null}</div></details>}
      {canAdjust && <TaskFeedback task={task} onAdjust={onAdjust} selectedProposalIds={selectedProposalIds} proposalOverrides={proposalOverrides} onProposalSelection={ids=>{setSelectedProposalIds(ids);setProposalOverrides(current=>Object.fromEntries(Object.entries(current).filter(([id])=>ids.includes(id))))}} />}{" "}
      {detail && (
        <Drawer
          project={task.project}
          item={detail}
          onClose={() => setDetail(undefined)}
        />
      )}{" "}
      {deleting && (
        <DeleteTaskDialog
          task={task}
          versions={versions.length}
          onCancel={() => setDeleting(false)}
          onConfirm={() => onDelete(task)}
        />
      )}
    </div>
  );
}
function DeleteTaskDialog({
  task,
  versions,
  onCancel,
  onConfirm,
}: {
  task: AnalysisTask;
  versions: number;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [cancelling, setCancelling] = useState(false),
    [error, setError] = useState(""),
    cancelRef = useRef<HTMLButtonElement>(null),
    dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null,
      bodyOverflow = document.body.style.overflow,
      root = document.getElementById("root"),
      hadInert = root?.hasAttribute("inert") ?? false,
      oldHidden = root?.getAttribute("aria-hidden");
    document.body.style.overflow = "hidden";
    root?.setAttribute("inert", "");
    root?.setAttribute("aria-hidden", "true");
    cancelRef.current?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !cancelling) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key === "Tab") {
        const controls = [
          ...(dialogRef.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled)",
          ) ?? []),
        ];
        if (!controls.length) return;
        const first = controls[0],
          last = controls.at(-1)!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", listener);
    return () => {
      window.removeEventListener("keydown", listener);
      document.body.style.overflow = bodyOverflow;
      if (!hadInert) root?.removeAttribute("inert");
      if (oldHidden == null) root?.removeAttribute("aria-hidden");
      else root?.setAttribute("aria-hidden", oldHidden);
      previous?.focus();
    };
  }, [cancelling, onCancel]);
  async function performDelete() {
    setCancelling(true);
    setError("");
    try {
      await onConfirm();
    } catch (value) {
      setError(value instanceof Error ? value.message : "删除失败，请重试。");
      setCancelling(false);
    }
  }
  return createPortal(
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-task-title"
        aria-describedby="delete-task-description"
      >
        <header>
          <Trash2 />
          <h2 id="delete-task-title">删除“{task.project.name}”</h2>
        </header>
        <p id="delete-task-description">
          {task.status === "running" || task.status === "queued"
            ? "将先停止当前执行，再删除"
            : "将删除"}
          平台托管的 {versions}{" "}
          个结果版本、检查点、输入快照和产物记录。原始文件及已复制到外部目录的文件不会删除。
        </p>
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button
            ref={cancelRef}
            className="secondary"
            disabled={cancelling}
            onClick={onCancel}
          >
            保留任务
          </button>
          <button
            className="danger"
            disabled={cancelling}
            aria-busy={cancelling}
            onClick={() => void performDelete()}
          >
            {cancelling ? "正在删除" : "删除任务"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export function loadFeedbackDraft(
  storage: Pick<Storage, "getItem"> | undefined,
  key: string,
) {
  try {
    return storage?.getItem(key) ?? "";
  } catch {
    return "";
  }
}
export function saveFeedbackDraft(
  storage: Pick<Storage, "setItem"> | undefined,
  key: string,
  value: string,
) {
  try {
    storage?.setItem(key, value);
  } catch {
    return;
  }
}
export function clearFeedbackDraft(
  storage: Pick<Storage, "removeItem"> | undefined,
  key: string,
) {
  try {
    storage?.removeItem(key);
  } catch {
    return;
  }
}
export function shouldSubmitFeedback(event: {
  ctrlKey: boolean;
  metaKey: boolean;
  key: string;
  nativeEvent: { isComposing: boolean };
}) {
  return (
    !event.nativeEvent.isComposing &&
    (event.ctrlKey || event.metaKey) &&
    event.key === "Enter"
  );
}
function feedbackStorage() {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function TaskFeedback({
  task,
  onAdjust,
  selectedProposalIds = [],
  proposalOverrides = {},
  onProposalSelection,
}: {
  task: AnalysisTask;
  onAdjust: (request: AdjustmentRequest) => Promise<void>;
  selectedProposalIds?: string[];
  proposalOverrides?: Record<string,string>;
  onProposalSelection?: (ids: string[]) => void;
}) {
  const storageKey = `prd-feedback-draft:${taskRootId(task)}`;
  const [draft, setDraft] = useState(() =>
    loadFeedbackDraft(feedbackStorage(), storageKey),
  );
  const [expanded, setExpanded] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<{
      kind: "error" | "success";
      text: string;
    }>();
  const results = task.adjustment?.results ?? [],
    applied = results.filter((item) => item.status === "applied").length,
    unresolved = results.filter((item) => item.status !== "applied").length;
  useEffect(() => {
    setDraft(loadFeedbackDraft(feedbackStorage(), storageKey));
    setMessage(undefined);
  }, [storageKey]);
  useEffect(() => {
    saveFeedbackDraft(feedbackStorage(), storageKey, draft);
  }, [storageKey, draft]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = task.project.clarifications.filter(
        (item) => selectedProposalIds.includes(item.id) && !item.userDecision && item.resolutionProposal,
      ),
      proposalText = selected
        .map(
          (item) =>
            `关于“${item.question}”，采纳建议方案：${proposalOverrides[item.id]??item.resolutionProposal!.recommendation}`,
        )
        .join("\n"),
      feedback = [draft.trim(), proposalText].filter(Boolean).join("\n");
    if (!feedback) {
      setMessage({ kind: "error", text: "请描述希望调整、补充或澄清的内容。" });
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      await onAdjust({
        baseTaskId: task.id,
        baseVersion: taskVersion(task),
        feedback,
        acceptedProposalIds: selected.map((item) => item.id),
        acceptedProposals: selected.map((item) => ({
          clarificationId: item.id,
          baseRecommendation: item.resolutionProposal!.recommendation,
          finalText: proposalOverrides[item.id] ?? item.resolutionProposal!.recommendation,
        })),
        references: selected.map((item) => ({
          kind: "clarification" as const,
          id: item.id,
        })),
      });
      setDraft("");
      onProposalSelection?.([]);
      clearFeedbackDraft(feedbackStorage(), storageKey);
      setMessage({
        kind: "success",
        text: "调整说明已提交，平台正在定位相关内容并生成新版本。",
      });
    } catch (value) {
      setMessage({
        kind: "error",
        text:
          value instanceof Error
            ? value.message
            : "提交失败，输入已保留，请重试。",
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={`task-feedback ${expanded ? "expanded" : ""}`}
      aria-labelledby="task-feedback-title"
    >
      {results.length > 0 && (
        <div className="feedback-outcome">
          <div>
            <strong>
              上次调整：已落实 {applied} 项
              {unresolved > 0 ? `，${unresolved} 项仍需处理` : ""}
            </strong>
            <span>以下结果按你提交的说明汇总。</span>
          </div>
          <ul>
            {results.map((item, index) => (
              <li className={item.status} key={`${item.operationId}-${index}`}>
                <b>
                  {item.status === "applied"
                    ? "已落实"
                    : item.status === "needs-confirmation"
                      ? "需要确认"
                      : item.status === "deferred"
                        ? "已保留待处理"
                        : "未成功"}
                </b>
                <span>{item.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {selectedProposalIds.length > 0 && (
          <div className="selected-proposals">
            <div>
              <strong>本次将采纳 {selectedProposalIds.length} 项建议方案{selectedProposalIds.filter(id=>proposalOverrides[id]).length?`，其中 ${selectedProposalIds.filter(id=>proposalOverrides[id]).length} 项已修改`:''}</strong>
              <span>可在下方补充例外或修改口径；你输入的说明优先。</span>
            </div>
            <button type="button" className="text-action" onClick={() => onProposalSelection?.([])}>
              清空选择
            </button>
          </div>
      )}
      <form noValidate onSubmit={submit}>
        <div className="task-feedback-heading">
          <div>
            <h2 id="task-feedback-title">描述你希望怎么调整</h2>
            <p>
              可以一次写多条意见、补充业务口径或回答多个澄清，平台会定位相关内容统一处理。
            </p>
          </div>
          <button
            className="text-action"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起输入区" : "展开输入区"}
          </button>
        </div>
        <label htmlFor="task-feedback-input" className="sr-only">
          调整说明
        </label>
        <textarea
          id="task-feedback-input"
          className="resize-none"
          rows={expanded ? 12 : 3}
          value={draft}
          disabled={busy}
          aria-invalid={message?.kind === "error"}
          aria-describedby="task-feedback-hint task-feedback-status"
          onChange={(event) => {
            setDraft(event.target.value);
            if (message) setMessage(undefined);
          }}
          onKeyDown={(event) => {
            if (shouldSubmitFeedback(event))
              event.currentTarget.form?.requestSubmit();
          }}
          placeholder="例如：订单查询的筛选条件合并描述；退款审核按发起、审核、完成展开。退款金额统一按含税处理，相关澄清一起更新。支付超时先保留，其他内容不动。"
        />
        <footer>
          <small id="task-feedback-hint">
            草稿会自动保存在本机。按 Ctrl+Enter 可提交。
          </small>
          <button
            className="primary"
            type="submit"
            disabled={busy || (!draft.trim() && !selectedProposalIds.length)}
            aria-busy={busy}
          >
            {busy
              ? "正在提交"
              : selectedProposalIds.length
                ? `按所选方案调整（${selectedProposalIds.length}）`
                : "按说明调整"}
          </button>
        </footer>
        {message && (
          <p
            id="task-feedback-status"
            className={`feedback-status ${message.kind}`}
            role={message.kind === "error" ? "alert" : "status"}
          >
            {message.text}
          </p>
        )}
      </form>
    </section>
  );
}
function metricNode(id: string) {
  if (id.includes("-asset-")) return "图片读取";
  if (id.includes("input-interpretation")) return "补充说明理解";
  if (id.includes("-proposal-")) return "阻塞事项建议";
  if (id.includes("-adjustment")) return "统一调整";
  if (id.includes("-candidate-")) return "功能候选识别";
  if (id.includes("-unify")) return "功能清单统一";
  if (id.includes("-coverage-")) return "功能完整性检查";
  if (id.includes("-details-")) return "逐功能细化";
  if (id.includes("-audit-")) return "完整性与忠实性检查";
  if (id.includes("-repair-")) return "局部修正";
  return "其他";
}
export function RuntimeCost({ task }: { task: AnalysisTask }) {
  const calls = task.runtimeMetrics ?? [];
  const prompts = task.checkpoint?.promptMetrics ?? [];
  if (!calls.length && !prompts.length) return null;
  const input = calls.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0),
    cached = calls.reduce(
      (sum, item) => sum + (item.cachedInputTokens ?? 0),
      0,
    ),
    output = calls.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0),
    measured = calls.some(
      (item) =>
        item.inputTokens !== undefined || item.outputTokens !== undefined,
    ),
    promptTokens=prompts.reduce((sum,item)=>sum+item.estimatedTokens,0),
    promptQueue=prompts.reduce((sum,item)=>sum+item.queueMs,0),
    validationRetries=prompts.filter(item=>item.attempt>1).length,
    timing = runtimeTiming(task),
    wall =
      (task.requestedAt??task.startedAt) === undefined
        ? 0
        : (task.completedAt ?? Date.now()) - (task.requestedAt??task.startedAt)!,
    groups = Object.values(
      calls.reduce<
        Record<
          string,
          {
            name: string;
            model: string;
            reasoningEffort: RuntimeConfig["reasoningEffort"];
            calls: number;
            duration: number;
            input: number;
            cached: number;
            output: number;
          }
        >
      >((all, item) => {
        const name = metricNode(item.sessionId),
          key = `${name}\u0000${item.model}\u0000${item.reasoningEffort}`,
          entry = (all[key] ??= {
            name,
            model: item.model,
            reasoningEffort: item.reasoningEffort,
            calls: 0,
            duration: 0,
            input: 0,
            cached: 0,
            output: 0,
          });
        entry.calls++;
        entry.duration += item.durationMs;
        entry.input += item.inputTokens ?? 0;
        entry.cached += item.cachedInputTokens ?? 0;
        entry.output += item.outputTokens ?? 0;
        all[key] = entry;
        return all;
      }, {}),
    );
  return (
    <section className="runtime-cost-wrap">
      <div className="runtime-cost">
        <div>
          <span>模型调用</span>
          <strong>{calls.length}</strong>
        </div>
        <div>
          <span>提示词估算</span>
          <strong>{promptTokens.toLocaleString()} Token</strong>
        </div>
        <div>
          <span>输入 Token</span>
          <strong>
            {measured ? input.toLocaleString() : "Runtime 未返回"}
          </strong>
        </div>
        <div>
          <span>缓存输入</span>
          <strong>{measured ? cached.toLocaleString() : "—"}</strong>
        </div>
        <div>
          <span>输出 Token</span>
          <strong>{measured ? output.toLocaleString() : "—"}</strong>
        </div>
        <div>
          <span>模型活跃耗时</span>
          <strong>{elapsed(0, timing.active)}</strong>
        </div>
        <div>
          <span>点击到结果</span>
          <strong>{elapsed(0, wall)}</strong>
        </div>
        <div>
          <span>模型排队</span>
          <strong>{elapsed(0,promptQueue)}</strong>
        </div>
        <div>
          <span>格式重试</span>
          <strong>{validationRetries}</strong>
        </div>
        {timing.retryWait > 0 && (
          <div>
            <span>等待重试</span>
            <strong>{elapsed(0, timing.retryWait)}</strong>
          </div>
        )}
      </div>
      <details>
        <summary>查看节点成本分布</summary>
        <div className="runtime-cost-table">
          <table>
            <thead>
              <tr>
                <th>节点</th>
                <th>模型</th>
                <th>推理深度</th>
                <th>调用</th>
                <th>累计耗时</th>
                <th>输入</th>
                <th>缓存输入</th>
                <th>输出</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((item) => (
                <tr key={`${item.name}-${item.model}-${item.reasoningEffort}`}>
                  <td>{item.name}</td>
                  <td>
                    <code>{item.model}</code>
                  </td>
                  <td>{reasoningLabels[item.reasoningEffort]}</td>
                  <td>{item.calls}</td>
                  <td>{elapsed(0, item.duration)}</td>
                  <td>{measured ? item.input.toLocaleString() : "—"}</td>
                  <td>{measured ? item.cached.toLocaleString() : "—"}</td>
                  <td>{measured ? item.output.toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
export function Progress({ task, now }: { task: AnalysisTask; now: number }) {
  const active = task.status === "running" || task.status === "queued";
  return (
    <section className="progress-card">
      <header>
        <div>
          <span>{active ? "正在执行" : task.status === "failed" ? "执行已停止" : "执行已完成"}</span>
          <h2>{active ? "Runtime 正在分析需求" : task.status === "failed" ? "Runtime 未完成本次任务" : "Runtime 已完成需求分析"}</h2>
        </div>
        <strong>{displayProgress(task.progress)}%</strong>
      </header>
      <div className="progress-track">
        <i style={{ width: `${task.progress}%` }} />
      </div>
      <div className="step-list">
        {task.steps.map((s, i) => {
          const current =
              s.status === "running" && s.startedAt ? now - s.startedAt : 0,
            total = (s.durationMs ?? 0) + current,
            items = stepRuntimeItems(task, s.id);
          return (
            <div className={`step ${s.status}`} key={s.id}>
              <i>{s.status === "completed" ? <CheckCircle2 /> : i + 1}</i>
              <div>
                <strong>{s.name}</strong>
                <small>
                  {stepDisplayNote(s.note)}
                  {(s.runs ?? 0) > 0 ? `；累计业务调用 ${s.runs} 次` : ""}
                </small>
                <div className="step-runtime">
                  {items.length ? (
                    items.map((item) => (
                      <small key={item.node}>
                        <b>{item.label}</b>
                        <span>{item.purpose}</span>
                        <code>{item.profile?.model ?? "模型配置未记录"}</code>
                        <em>
                          {item.profile
                            ? `推理 ${reasoningLabels[item.profile.reasoningEffort]}`
                            : "—"}
                        </em>
                      </small>
                    ))
                  ) : (
                    <small className="deterministic">
                      <b>执行方式</b>
                      <span>由确定性脚本处理</span>
                      <em>不使用模型</em>
                    </small>
                  )}
                </div>
              </div>
              <span>
                {s.status === "running"
                  ? `已执行 ${elapsed(0, total)}`
                  : s.status === "completed"
                    ? `累计 ${elapsed(0, total)}`
                    : "等待执行"}
              </span>
            </div>
          );
        })}
      </div>
      <footer>
        <Clock3 />
        点击到当前结果 {elapsed(task.requestedAt??task.startedAt, task.completedAt, now)}
      </footer>
    </section>
  );
}

function Results({
  task,
  project,
  tab,
  setTab,
  featureFilter,
  setFeatureFilter,
  onDetail,
  onScope,
  selectedProposalIds,
  onProposalSelection,
  proposalOverrides,
  onProposalOverride,
  onGenerateProposals,
  generatingProposals,
  failureAction,
  onRecover,
  now,
}: {
  task: AnalysisTask;
  project: PrdProject;
  tab: ResultTab;
  setTab: (t: ResultTab) => void;
  featureFilter?: string;
  setFeatureFilter: (id?: string) => void;
  onDetail: (r: RequirementDetail) => void;
  onScope: (request: DeliveryScopeUpdateRequest) => Promise<void>;
  selectedProposalIds: string[];
  onProposalSelection: (ids: string[]) => void;
  proposalOverrides: Record<string,string>;
  onProposalOverride: (id:string,value:string|undefined) => void;
  onGenerateProposals: () => void;
  generatingProposals: boolean;
  failureAction?: "retry" | "restart";
  onRecover: (action: "retry" | "restart") => void;
  now: number;
}) {
  const counts = clarificationCounts(project),
    tabs: [ResultTab, string][] = [
      ["features", "功能与需求"],
      ["requirements", "全部需求"],
      ["issues", "待处理事项"],
      ["execution", "执行记录"],
    ];
  return (
    <section className="result-workspace">
      <nav className="result-tabs" aria-label="任务结果视图">
        {tabs.map(([id, label]) => (
          <button
            aria-pressed={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => {
              setTab(id);
              if (id === "requirements") setFeatureFilter(undefined);
            }}
            key={id}
          >
            {label}
            {id === "issues" && (
              <b>
                {counts.blocking +
                  counts.suggestion +
                  counts.ignorable +
                  counts.platform}
              </b>
            )}
          </button>
        ))}
      </nav>
      <div className="result-body">
        {tab === "features" ? (
          <FeatureList
            task={task}
            p={project}
            onNext={(id) => {
              setFeatureFilter(id);
              setTab("requirements");
            }}
            onScope={onScope}
          />
        ) : tab === "requirements" ? (
          <RequirementList
            task={task}
            p={project}
            featureId={featureFilter}
            onClearFeature={() => setFeatureFilter(undefined)}
            onDetail={onDetail}
            onScope={onScope}
          />
        ) : tab === "issues" ? (
          <ResultIssues
            project={project}
            selectedProposalIds={selectedProposalIds}
            onProposalSelection={onProposalSelection}
            proposalOverrides={proposalOverrides}
            onProposalOverride={onProposalOverride}
            onGenerateProposals={onGenerateProposals}
            generating={generatingProposals}
          />
        ) : (
          <ExecutionRecord task={task} now={now} failureAction={failureAction} onRecover={onRecover} />
        )}
      </div>
    </section>
  );
}
export function ExecutionRecord({ task, now, failureAction, onRecover }: { task: AnalysisTask; now: number; failureAction?: "retry" | "restart"; onRecover?: (action: "retry" | "restart") => void }) {
  return (
    <section className="execution-record">
      {task.error && task.status === "failed" && (
        <div className="workspace-error" role="alert">
          <AlertTriangle />
          <div>
            <strong>
              {task.status === "failed" ? "任务执行失败" : "执行需要处理"}
            </strong>
            <p>{task.error}</p>
            {onRecover && !task.archivedAt && (
              <div className="failure-actions">
                <button className="primary" disabled={!!failureAction} aria-busy={failureAction === "retry"} onClick={() => onRecover("retry")}>
                  <RotateCw />
                  {failureAction === "retry" ? "正在继续" : "从失败处继续"}
                </button>
                <button className="secondary" disabled={!!failureAction} aria-busy={failureAction === "restart"} onClick={() => onRecover("restart")}>
                  {failureAction === "restart" ? "正在重新开始" : "重新开始"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      <Progress task={task} now={now} />
      <RuntimeCost task={task} />
    </section>
  );
}
type ScopeFilter = "all" | "current" | "excluded";
function featureScope(
  project: PrdProject,
  feature: PrdProject["features"][number],
) {
  const requirements = feature.requirementIds
      .map((id) => project.requirements.find((item) => item.id === id))
      .filter(Boolean) as RequirementDetail[],
    current = requirements.filter(
      (item) => item.deliveryScope !== "excluded",
    ).length;
  if (feature.deliveryScope === "excluded" || current === 0)
    return {
      value: "excluded" as const,
      label: "本期不做",
      current,
      total: requirements.length,
    };
  if (current < requirements.length)
    return {
      value: "partial" as const,
      label: `部分纳入（${current}/${requirements.length}）`,
      current,
      total: requirements.length,
    };
  return {
    value: "current" as const,
    label: "本期",
    current,
    total: requirements.length,
  };
}
function ScopeToolbar({
  selected,
  pageIds,
  allIds,
  busy,
  message,
  onSelected,
  onApply,
}: {
  selected: string[];
  pageIds: string[];
  allIds: string[];
  busy: boolean;
  message: string;
  onSelected: (ids: string[]) => void;
  onApply: (scope: "current" | "excluded") => void;
}) {
  return (
    <div className="scope-toolbar">
      <div>
        <strong>已选 {selected.length} 项</strong>
        <span>
          {selected.length
            ? `当前筛选共 ${allIds.length} 项`
            : "复选框只选择本次批量操作，不代表已保存范围。"}
        </span>
      </div>
      <div className="scope-select-actions">
        <button
          className="text-action"
          disabled={!pageIds.length}
          onClick={() => onSelected([...new Set([...selected, ...pageIds])])}
        >
          全选本页
        </button>
        <button
          className="text-action"
          disabled={!allIds.length}
          onClick={() => onSelected(allIds)}
        >
          选择当前筛选全部（{allIds.length}）
        </button>
      </div>
      <div className="scope-bulk-actions">
        <button
          className="secondary"
          disabled={!selected.length || busy}
          onClick={() => onApply("excluded")}
        >
          标记本期不做
        </button>
        <button
          className="secondary"
          disabled={!selected.length || busy}
          onClick={() => onApply("current")}
        >
          恢复本期
        </button>
        <button
          className="text-action"
          disabled={!selected.length || busy}
          onClick={() => onSelected([])}
        >
          取消选择
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
function FeatureList({
  task,
  p,
  onNext,
  onScope,
}: {
  task: AnalysisTask;
  p: PrdProject;
  onNext: (id: string) => void;
  onScope: (request: DeliveryScopeUpdateRequest) => Promise<void>;
}) {
  const [q, setQ] = useState(""),
    [filter, setFilter] = useState<ScopeFilter>("all"),
    [selected, setSelected] = useState<string[]>([]),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const rows = useMemo(
    () =>
      p.features
        .filter((feature) => feature.kind !== "constraint")
        .filter((feature) => {
          const scope = featureScope(p, feature);
          return (
            featureTitle(p, feature).includes(q) &&
            (filter === "all" ||
              scope.value === filter ||
              (filter === "current" && scope.value === "partial"))
          );
        }),
    [p, q, filter],
  );
  const pageSize = 30,
    pages = Math.max(1, Math.ceil(rows.length / pageSize)),
    visible = rows.slice((page - 1) * pageSize, page * pageSize);
  function changeView(nextQ: string, nextFilter: ScopeFilter) {
    setQ(nextQ);
    setFilter(nextFilter);
    setPage(1);
    if (selected.length) {
      setSelected([]);
      setMessage("筛选已变化，原选择已取消。");
    }
  }
  async function apply(scope: "current" | "excluded") {
    setBusy(true);
    setMessage("");
    try {
      await onScope({
        baseTaskId: task.id,
        baseVersion: taskVersion(task),
        scope,
        targets: selected.map((id) => ({ kind: "feature", id })),
      });
      setMessage(
        scope === "excluded"
          ? `已将 ${selected.length} 个功能标记为本期不做。`
          : `已将 ${selected.length} 个功能恢复为本期。`,
      );
      setSelected([]);
    } catch (value) {
      setMessage(
        value instanceof Error ? value.message : "范围更新失败，请重试。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Collection title="功能与需求" count={rows.length}>
      <ListControls
        q={q}
        filter={filter}
        onChange={changeView}
        label="搜索功能"
      />
      <ScopeToolbar
        selected={selected}
        pageIds={visible.map((item) => item.id)}
        allIds={rows.map((item) => item.id)}
        busy={busy}
        message={message}
        onSelected={setSelected}
        onApply={(scope) => void apply(scope)}
      />
      <div className="data-table features scope-table">
        <div className="thead">
          <label className="row-select">
            <input
              type="checkbox"
              aria-label="全选本页功能"
              checked={
                visible.length > 0 &&
                visible.every((item) => selected.includes(item.id))
              }
              onChange={(event) => {
                const pageIds = visible.map((item) => item.id);
                setSelected((current) =>
                  event.target.checked
                    ? [...new Set([...current, ...pageIds])]
                    : current.filter((id) => !pageIds.includes(id)),
                );
              }}
            />
          </label>
          <span>功能名称</span>
          <span>原文位置</span>
          <span>需求</span>
          <span>本期范围</span>
        </div>
        {visible.length === 0 && (
          <p className="empty-result">没有匹配的功能，请调整搜索或范围筛选。</p>
        )}
        {visible.map((feature) => {
          const source = p.sourceUnits.find(
              (item) => item.id === feature.sourceUnitIds[0],
            ),
            checked = selected.includes(feature.id),
            scope = featureScope(p, feature);
          return (
            <div className="data-row feature-row" key={feature.id}>
              <label className="row-select">
                <input
                  type="checkbox"
                  checked={checked}
                  aria-label={`选择 ${featureTitle(p, feature)}`}
                  onChange={() =>
                    setSelected((current) =>
                      checked
                        ? current.filter((id) => id !== feature.id)
                        : [...current, feature.id],
                    )
                  }
                />
              </label>
              <button
                className="feature-open"
                onClick={() => onNext(feature.id)}
              >
                <span>
                  <strong>{featureTitle(p, feature)}</strong>
                  <small>{feature.id}</small>
                </span>
                <span>{source ? sourcePosition(source) : "来源待定位"}</span>
                <b>{feature.requirementIds.length}</b>
                <em className={`scope-badge ${scope.value}`}>{scope.label}</em>
              </button>
            </div>
          );
        })}
      </div>
      <Pagination
        page={page}
        pages={pages}
        pageSize={pageSize}
        onPage={setPage}
      />
    </Collection>
  );
}
function RequirementList({
  task,
  p,
  featureId,
  onClearFeature,
  onDetail,
  onScope,
}: {
  task: AnalysisTask;
  p: PrdProject;
  featureId?: string;
  onClearFeature: () => void;
  onDetail: (r: RequirementDetail) => void;
  onScope: (request: DeliveryScopeUpdateRequest) => Promise<void>;
}) {
  const [q, setQ] = useState(""),
    [filter, setFilter] = useState<ScopeFilter>("all"),
    [selected, setSelected] = useState<string[]>([]),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const feature = p.features.find((item) => item.id === featureId),
    allowed = feature ? new Set(feature.requirementIds) : undefined,
    rows = useMemo(
      () =>
        p.requirements.filter(
          (item) =>
            (!allowed || allowed.has(item.id)) &&
            `${item.id}${item.text}`.includes(
              q,
            ) &&
            (filter === "all" ||
              (filter === "excluded") === (item.deliveryScope === "excluded")),
        ),
      [p, q, filter, featureId],
    );
  const pageSize = 50,
    pages = Math.max(1, Math.ceil(rows.length / pageSize)),
    visible = rows.slice((page - 1) * pageSize, page * pageSize);
  function changeView(nextQ: string, nextFilter: ScopeFilter) {
    setQ(nextQ);
    setFilter(nextFilter);
    setPage(1);
    if (selected.length) {
      setSelected([]);
      setMessage("筛选已变化，原选择已取消。");
    }
  }
  async function apply(scope: "current" | "excluded") {
    setBusy(true);
    setMessage("");
    try {
      await onScope({
        baseTaskId: task.id,
        baseVersion: taskVersion(task),
        scope,
        targets: selected.map((id) => ({ kind: "requirement", id })),
      });
      setMessage(
        scope === "excluded"
          ? `已将 ${selected.length} 条需求标记为本期不做。`
          : `已将 ${selected.length} 条需求恢复为本期。`,
      );
      setSelected([]);
    } catch (value) {
      setMessage(
        value instanceof Error ? value.message : "范围更新失败，请重试。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Collection
      title={feature ? `需求明细 · ${featureTitle(p, feature)}` : "全部需求"}
      count={rows.length}
    >
      {feature && (
        <button className="text-action clear-feature" onClick={onClearFeature}>
          查看全部需求
        </button>
      )}
      <ListControls
        q={q}
        filter={filter}
        onChange={changeView}
        label="搜索需求"
      />
      <ScopeToolbar
        selected={selected}
        pageIds={visible.map((item) => item.id)}
        allIds={rows.map((item) => item.id)}
        busy={busy}
        message={message}
        onSelected={setSelected}
        onApply={(scope) => void apply(scope)}
      />
      <div className="data-table requirements scope-table">
        <div className="thead">
          <label className="row-select">
            <input
              type="checkbox"
              aria-label="全选本页需求"
              checked={
                visible.length > 0 &&
                visible.every((item) => selected.includes(item.id))
              }
              onChange={(event) => {
                const pageIds = visible.map((item) => item.id);
                setSelected((current) =>
                  event.target.checked
                    ? [...new Set([...current, ...pageIds])]
                    : current.filter((id) => !pageIds.includes(id)),
                );
              }}
            />
          </label>
          <span>编号</span>
          <span>需求明细</span>
          <span>原文</span>
          <span>检查状态</span>
          <span>本期范围</span>
        </div>
        {visible.length === 0 && (
          <p className="empty-result">没有匹配的需求，请调整搜索或范围筛选。</p>
        )}
        {visible.map((item) => {
          const checked = selected.includes(item.id);
          return (
            <div className="data-row requirement-row" key={item.id}>
              <label className="row-select">
                <input
                  type="checkbox"
                  checked={checked}
                  aria-label={`选择 ${item.text}`}
                  onChange={() =>
                    setSelected((current) =>
                      checked
                        ? current.filter((id) => id !== item.id)
                        : [...current, item.id],
                    )
                  }
                />
              </label>
              <button
                className="requirement-open"
                onClick={() => onDetail(item)}
              >
                <code>{item.id}</code>
                <span>
                  <strong>{item.text}</strong>
                  <small>{p.features.find(feature => feature.id === item.featureId) ? featureTitle(p, p.features.find(feature => feature.id === item.featureId)!) : '模块待定位'}</small>
                </span>
                <b>{item.sourceRefs.length}</b>
                <b>
                  {item.state === "needs-clarification"
                    ? "有待澄清项"
                    : item.state === "reviewed"
                      ? "检查通过"
                      : "尚未检查"}
                </b>
                <em
                  className={`scope-badge ${item.deliveryScope === "excluded" ? "excluded" : "current"}`}
                >
                  {item.deliveryScope === "excluded" ? "本期不做" : "本期"}
                </em>
              </button>
            </div>
          );
        })}
      </div>
      <Pagination
        page={page}
        pages={pages}
        pageSize={pageSize}
        onPage={setPage}
      />
    </Collection>
  );
}
function ListControls({
  q,
  filter,
  onChange,
  label,
}: {
  q: string;
  filter: ScopeFilter;
  onChange: (q: string, filter: ScopeFilter) => void;
  label: string;
}) {
  return (
    <div className="list-controls">
      <label className="search">
        <Search />
        <input
          value={q}
          onChange={(event) => onChange(event.target.value, filter)}
          aria-label={label}
          placeholder={`${label}名称或内容`}
        />
        {q && (
          <button
            aria-label={`清空${label}`}
            onClick={(event) => {
              onChange("", filter);
              event.currentTarget.parentElement
                ?.querySelector("input")
                ?.focus();
            }}
          >
            <X />
          </button>
        )}
      </label>
      <div className="scope-filters" aria-label="本期范围筛选">
        {(
          [
            ["all", "全部"],
            ["current", "本期"],
            ["excluded", "本期不做"],
          ] as Array<[ScopeFilter, string]>
        ).map(([id, text]) => (
          <button
            key={id}
            aria-pressed={filter === id}
            className={filter === id ? "active" : ""}
            onClick={() => onChange(q, id)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
function Pagination({
  page,
  pages,
  pageSize,
  onPage,
}: {
  page: number;
  pages: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  return pages > 1 ? (
    <footer className="pagination">
      <span>
        第 {page}/{pages} 页 · 每页最多 {pageSize} 项
      </span>
      <div>
        <button
          className="secondary"
          disabled={page === 1}
          onClick={() => onPage(page - 1)}
        >
          上一页
        </button>
        <button
          className="secondary"
          disabled={page === pages}
          onClick={() => onPage(page + 1)}
        >
          下一页
        </button>
      </div>
    </footer>
  ) : null;
}
function Collection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="collection result">
      <div className="collection-head">
        <h2>
          {title} <b>{count}</b>
        </h2>
      </div>
      {children}
    </section>
  );
}
function Drawer({
  project,
  item,
  onClose,
}: {
  project: PrdProject;
  item: RequirementDetail;
  onClose: () => void;
}) {
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
  return (
    <aside className="drawer" aria-label="需求明细">
      <header>
        <div>
          <code>{item.id}</code>
          <h2>{item.text}</h2>
          <small>
            {item.state === "needs-clarification"
              ? "有待澄清项"
              : item.state === "reviewed"
                ? "检查通过"
                : "尚未检查"}
          </small>
        </div>
        <button onClick={onClose} aria-label="关闭">
          <X />
        </button>
      </header>
      <div>
        <h3>原文及位置</h3>
        {requirementSourceRefs(item).map((ref, index) => {
          const source = project.sourceUnits.find(
            (s) => s.id === ref.sourceUnitId,
          );
          return source ? (
            <section
              className="source-card"
              key={`${ref.sourceUnitId}-${ref.start ?? "all"}-${index}`}
            >
              <strong>{sourceHeading(source)}</strong>
              <small>{sourcePosition(source)}</small>
              {readableContext(source.context) && (
                <p>{readableContext(source.context)}</p>
              )}
              <p className="source-excerpt">{sourceExcerpt(source, ref)}</p>
            </section>
          ) : (
            <p key={`${ref.sourceUnitId}-${index}`}>来源待定位</p>
          );
        })}
      </div>
    </aside>
  );
}

function RuntimeSettings({
  status,
  onStatus,
}: {
  status: RuntimeStatus;
  onStatus: (s: RuntimeStatus) => void;
}) {
  const [config, setConfig] = useState<RuntimeConfig>({
    adapter: "codex-oauth",
    provider: "openai-codex",
    fastModel: "gpt-5.6-luna",
    fastReasoningEffort: "low",
    model: "gpt-5.6-terra",
    reasoningEffort: "low",
    nodeProfiles: defaultNodeProfiles("codex-oauth"),
    maxParallel: 5,
    maxNodeParallel: 10,
  });
  const [saved, setSaved] = useState(false);
  const [checking, setChecking] = useState<"status" | "connection" | null>(
    null,
  );
  const [checkedAt, setCheckedAt] = useState<string>();
  const [checkError, setCheckError] = useState("");
  const [lastCheck, setLastCheck] = useState(false);
  useEffect(() => {
    window.prdApp?.loadRuntimeConfig().then(setConfig);
  }, []);
  async function save() {
    setSaved(false);
    setCheckError("");
    try {
      await window.prdApp?.saveRuntimeConfig(config);
      setSaved(true);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : "配置保存失败，请重试");
    }
  }
  async function check(connection = false) {
    if (checking || !window.prdApp) return;
    setLastCheck(connection);
    setChecking(connection ? "connection" : "status");
    setCheckError("");
    try {
      const result = await (connection
        ? window.prdApp.testRuntime(config)
        : window.prdApp.inspectRuntime(config));
      onStatus(result);
      setCheckedAt(new Date().toLocaleTimeString("zh-CN"));
      if (result.reason || result.authStatus === "error")
        setCheckError(result.reason ?? "认证状态读取失败，请重试");
    } catch {
      setCheckError("未能取得检查结果，请重试；下方保留上次结果。");
    } finally {
      setChecking(null);
    }
  }
  function changeAdapter(adapter: RuntimeConfig["adapter"]) {
    setConfig(
      adapter === "codex-oauth"
        ? {
            ...config,
            adapter,
            provider: "openai-codex",
            fastModel: "gpt-5.6-luna",
            fastReasoningEffort: "low",
            model: "gpt-5.6-terra",
            reasoningEffort: "low",
            nodeProfiles: defaultNodeProfiles(adapter),
            apiKey: undefined,
          }
        : {
            ...config,
            adapter,
            provider: "deepseek-official",
            fastModel: "deepseek-v4-flash",
            fastReasoningEffort: "low",
            model: "deepseek-v4",
            reasoningEffort: "low",
            nodeProfiles: defaultNodeProfiles(adapter),
          },
    );
  }
  function updateNode(node: ModelNodeId, patch: Partial<ModelProfile>) {
    const fallback = defaultNodeProfiles(config.adapter)[node],
      current = config.nodeProfiles?.[node] ?? fallback;
    setConfig({
      ...config,
      nodeProfiles: {
        ...config.nodeProfiles,
        [node]: { ...current, ...patch },
      },
    });
  }
  const state = status.routeReady
    ? "已连接"
    : status.available
      ? "已安装，待验证"
      : "未连接";
  const codexModels = [
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.3-codex-spark",
  ];
  return (
    <div className="page settings-page">
      <div className="page-title">
        <div>
          <span>运行时设置</span>
          <h1>统一 Runtime 配置</h1>
          <p>选择执行适配器、模型与推理深度；新任务会固化当前配置。</p>
        </div>
      </div>
      <section className="settings-card">
        <header>
          <SlidersHorizontal />
          <div>
            <h2>模型执行配置</h2>
            <p>
              {config.adapter === "codex-oauth"
                ? "官方 Codex CLI · 复用 CLI 认证"
                : "DeepSeek Harness · SDK JSON-RPC"}
            </p>
          </div>
          <em className={status.routeReady ? "connected" : ""}>{state}</em>
        </header>
        <div className="form-grid">
          <label>
            <span>Runtime 适配器</span>
            <select
              disabled={!!checking}
              value={config.adapter}
              onChange={(e) =>
                changeAdapter(e.target.value as RuntimeConfig["adapter"])
              }
            >
              <option value="codex-oauth">Codex CLI</option>
              <option value="dsh">DeepSeek Harness</option>
            </select>
            <small>平台调度协议保持一致，底层执行器可切换</small>
          </label>
          {config.adapter === "dsh" && (
            <label>
              <span>Provider</span>
              <input
                value={config.provider}
                onChange={(e) =>
                  setConfig({ ...config, provider: e.target.value })
                }
              />
              <small>Harness 中注册的提供方标识</small>
            </label>
          )}
          <label>
            <span>网络代理</span>
            <input
              type="url"
              value={config.proxyUrl ?? ""}
              onChange={(e) =>
                setConfig({ ...config, proxyUrl: e.target.value })
              }
              placeholder="例如 http://127.0.0.1:7890"
            />
            <small>可选；连接检测和新任务都会通过此代理访问模型</small>
          </label>
          <div className="node-profiles">
            <div className="node-profile-head">
              <strong>节点模型策略</strong>
              <span>模型</span>
              <span>推理深度</span>
            </div>
            {modelNodes.map(([id, name, note]) => {
              const profile =
                config.nodeProfiles?.[id] ??
                defaultNodeProfiles(config.adapter)[id];
              return (
                <div className="node-profile-row" key={id}>
                  <div>
                    <strong>{name}</strong>
                    <small>{note}</small>
                  </div>
                  {config.adapter === "codex-oauth" ? (
                    <select
                      aria-label={`${name}模型`}
                      value={profile.model}
                      onChange={(e) =>
                        updateNode(id, { model: e.target.value })
                      }
                    >
                      {codexModels.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label={`${name}模型`}
                      value={profile.model}
                      onChange={(e) =>
                        updateNode(id, { model: e.target.value })
                      }
                    />
                  )}
                  <select
                    aria-label={`${name}推理深度`}
                    value={profile.reasoningEffort}
                    onChange={(e) =>
                      updateNode(id, {
                        reasoningEffort: e.target
                          .value as RuntimeConfig["reasoningEffort"],
                      })
                    }
                  >
                    <option value="default">模型默认</option>
                    <option value="low">低</option>
                    <option value="medium">中</option>
                    <option value="high">高</option>
                    {config.adapter === "codex-oauth" && (
                      <>
                        <option value="xhigh">XHigh</option>
                        <option value="max">Max</option>
                        <option value="ultra">Ultra</option>
                      </>
                    )}
                  </select>
                </div>
              );
            })}
          </div>
          {config.adapter === "dsh" &&
            config.provider === "deepseek-official" && (
              <label>
                <span>DeepSeek API Key</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={config.apiKey ?? ""}
                  onChange={(e) =>
                    setConfig({ ...config, apiKey: e.target.value })
                  }
                  placeholder="输入后由系统加密保存"
                />
                <small>仅注入 Harness 子进程</small>
              </label>
            )}
          <label>
            <span>最大并行任务</span>
            <input
              type="number"
              min="1"
              max="8"
              value={config.maxParallel}
              onChange={(e) =>
                setConfig({ ...config, maxParallel: Number(e.target.value) })
              }
            />
            <small>超过数量的任务进入排队</small>
          </label>
          <label>
            <span>单任务节点并发</span>
            <input
              type="number"
              min="1"
              max="10"
              value={config.maxNodeParallel ?? 10}
              onChange={(e) =>
                setConfig({
                  ...config,
                  maxNodeParallel: Number(e.target.value),
                })
              }
            />
            <small>逐功能细化与审计的并发上限</small>
          </label>
        </div>
        <footer>
          <button
            className="secondary runtime-check-button"
            aria-busy={checking === "status"}
            disabled={!!checking}
            onClick={() => check()}
          >
            <RotateCw
              className={checking === "status" ? "runtime-spinner" : ""}
            />
            {checking === "status" ? "刷新中" : "刷新状态"}
          </button>
          <button
            className="secondary runtime-check-button"
            aria-busy={checking === "connection"}
            disabled={!!checking}
            onClick={() => check(true)}
          >
            <RotateCw
              className={checking === "connection" ? "runtime-spinner" : ""}
            />
            {checking === "connection" ? "连接检测中" : "检测 Runtime 连接"}
          </button>
          <button className="primary" onClick={save}>
            保存配置
          </button>
          {saved && <span>已保存</span>}
        </footer>
      </section>
      <section className="runtime-info">
        <h2>运行时信息</h2>
        <div
          className={`runtime-feedback ${checkError ? "has-error" : ""}`}
          role="status"
          aria-live="polite"
        >
          <div>
            <strong>
              {checking
                ? checking === "status"
                  ? "正在读取运行时状态"
                  : "正在验证 Runtime 连接"
                : checkError
                  ? "检查未完成"
                  : checkedAt
                    ? "检查完成"
                    : "运行时检查"}
            </strong>
            <span>
              {checking
                ? checking === "status"
                  ? "读取安装版本与认证状态，通常几秒内完成。"
                  : "通过当前代理发送一次最小请求，请稍候。"
                : checkError ||
                  (checkedAt
                    ? `更新于 ${checkedAt}`
                    : "刷新状态不调用模型；Runtime 连接需单独检测。")}
            </span>
          </div>
          {checking && (
            <RotateCw className="runtime-spinner" aria-hidden="true" />
          )}
          {!checking && checkError && (
            <button className="secondary" onClick={() => check(lastCheck)}>
              重试
            </button>
          )}
        </div>
        <dl>
          <div>
            <dt>适配器</dt>
            <dd>
              {status.adapter === "codex-oauth"
                ? "Codex CLI"
                : status.adapter === "dsh"
                  ? "DeepSeek Harness"
                  : "—"}
            </dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{state}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>
              {checking === "status" ? (
                <span className="runtime-pending">读取版本中</span>
              ) : (
                (status.version ?? "—")
              )}
            </dd>
          </div>
          <div>
            <dt>可执行文件</dt>
            <dd>{status.launcher ?? status.reason ?? "—"}</dd>
          </div>
          {status.adapter === "codex-oauth" && (
            <div>
              <dt>认证状态</dt>
              <dd>
                {checking === "status" ? (
                  <span className="runtime-pending">读取认证状态中</span>
                ) : status.authStatus === "authenticated" ? (
                  "已登录"
                ) : status.authStatus === "unauthenticated" ? (
                  "未登录，请在终端运行 Codex CLI 的 login 命令"
                ) : status.authStatus === "error" ? (
                  "检查失败，请刷新重试"
                ) : (
                  "尚未检查"
                )}
              </dd>
            </div>
          )}
          <div>
            <dt>模型连接</dt>
            <dd>
              {checking === "connection" ? (
                <span className="runtime-pending">等待模型响应</span>
              ) : status.routeReady === true ? (
                "可用"
              ) : status.routeReady === false ? (
                "检测失败"
              ) : (
                "尚未检测"
              )}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

export { TaskPage, featureScope, RequirementList, Drawer };
