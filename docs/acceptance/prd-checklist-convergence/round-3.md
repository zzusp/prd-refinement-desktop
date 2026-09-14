# Round 3：仅功能模块与需求清单

## 范围

验证 Pipeline 27 从模型契约、七阶段调度、调整、页面到交付包均不再生成或展示待处理事项、阻塞分析、建议和澄清；平台执行错误与原文忠实性核查继续保留。

## 已通过证据

- `npm test`：删除无运行入口的旧澄清核查死链后，23 个测试文件、241 个测试通过。
- `npm run typecheck`：前端与 Electron 类型检查通过。
- `npm run build`：1585 个模块完成生产构建。
- `npm run verify:premium`：UI contract smoke check passed。
- frontend-design-premium strict audit：0 findings，记录在 `round-3/premium-audit.json`。
- 受控 Edge：结果仅有功能与需求、全部需求、执行记录；旧业务问题不展示；原文抽屉、平台核查抽屉焦点恢复、调整失败保留输入及 1100px 视口通过。
- 新版导出器回读历史真实任务快照：34 个模块、200 条需求；只输出 README、CSV、两工作表 Excel、features、manifest、requirements 和 sources；原任务及冻结文件哈希不变。该项未调用模型。
- 实际 Electron 以隔离 `gpt-5.6-terra` 重跑冻结长 PRD，任务 `T-B741D978` 完成 Pipeline 27 全七阶段：8 个模块、168 条需求、0 项澄清，交付评估为 ready，原 PRD SHA-256 `7977bf23a93ec394a1415d84b2947c5675af81adfbfb3f93e211d68ed65e6de5` 未变。
- 实际结果页只读回查得到 `功能与需求 / 全部需求 / 执行记录` 三个视图，页面显示 168 条需求，无待处理事项和建议入口；截图为 `docs/tmp/acceptance/prd-checklist-only-real-27/result.png`。
- 真实任务的 current exporter 回读为 schema v4、qualityState `ready`；仅含 README、checklist.csv、checklist.xlsx、features.json、manifest.json、requirements.json、sources.json，Excel 为 169×7 的需求清单和 4×2 的阅读说明，冻结文件哈希逐项一致。
- 回读发现调度器写包时任务尚未落 `completed`，首包被误标 `unchecked`。根因不是模型输出，而是完成状态与包生成的时序；修复为仅在交付评估 ready 时向导出器传递完成态投影，未提前改变持久化任务状态，并以调度器测试直接读取 manifest 验证为 `ready`。

## 反证检查

- 曾尝试按需求文本跨批次去重；全量测试证明它会错误折叠不同证据下的同文要求，并破坏显式关系目标，因此已完整撤回。当前只按结构化身份保留来源不同的需求，不以文本相同推断重复。
- 真实任务中仍可能存在语义相近或相同的原文要求；这不等于平台添加推测，也不能据此宣称自然语言“100% 零遗漏”。

## 边界

独立 Artifact Tool 将一个实际为空的 XLSX 共享字符串显示为索引 `13`；ExcelJS 与 XLSX XML 均确认实际值为空。因此不把 Artifact Tool 单项预览描述为全通过。

隔离验收改用 Terra 只证明新流程在该模型和该冻结任务上完成，不记为原日常模型的容量恢复或回归通过。
