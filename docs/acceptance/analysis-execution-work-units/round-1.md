# 第 1 轮验证

日期：2026-09-14

## 自动验证

- `npm run typecheck`：通过。
- `npm test`：20 个测试文件、209 项测试全部通过。
- `npm run build`：TypeScript、Vite 和 Electron 主进程构建通过。
- `npm run verify:premium`：UI contract smoke check passed。
- 源码搜索确认不存在 `PromptBudgetExceededError`、`assertPromptBudget`、`targetTokens`、`hardTokens`、token 比较分支或 maxTokens 分片参数。

关键调度反例已经反转：超过旧 audit 上限的请求实际到达模拟 Runtime，并保存估算用量；两个功能中 F-001 audit 成功、F-002 首次 Runtime 故障时，任务准确失败且没有生成 AuditIssue。重试后 F-001 总调用仍为 1 次，F-002 为 2 次，ExecutionFailure 被成功结果关闭。

## 真实 Runtime

`scripts/restart-real-task.mjs --check` 回读源任务 `T-14BAB15B`：状态 needs-attention、pipeline 19、冻结项目 ID 与 sourceHash 保持不变，Runtime 为 codex-oauth / gpt-5.6-terra。

随后从冻结输入创建 pipeline 20 任务 `T-77F83164`。真实 Runtime 已产生 43 条 prompt metric，没有出现平台 token 拒绝。该任务在功能候选重分类阶段达到两轮反馈上限，错误为候选将待确认事项错误归类为 requirement；进度停在 28.57%，尚未进入逐功能细化和 audit。因此本轮只能证明新协议已实际启动及 token 门禁未在此前调用中触发，不能证明原 F-001 audit 已通过。

真实运行摘要见 `round-1/real-task-run.json`。源任务未覆盖，新任务失败记录保留。

已重新启动实际 Electron 开发实例。四个 Electron 进程启动于 14:39:25–14:39:29；启动日志显示 Vite 就绪，当前编译产物独立回读为 `CURRENT_PIPELINE_VERSION = 20`。

## 未完成边界

- 需在候选重分类的独立语义问题修复后，再运行同一冻结样本，核对所有 audit 工作成功并生成正式交付包。
