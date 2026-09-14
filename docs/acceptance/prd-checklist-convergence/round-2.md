# 第二轮：保留完整流程的轻量清单验收

## 结论

Pipeline 26 按七阶段完成真实长 PRD，正式需求收敛为功能模块下的简短清单，同时保留待处理事项、建议方案、用户决定、关系、审计修正和恢复能力。

## 自动验证

- `npm test`：24 个测试文件、261 个测试通过。
- `npm run typecheck`：通过。
- `npm run build`：通过，Vite 生成正式前端产物。
- `npm run verify:premium`：严格 UI 契约零发现。

## 真实 Electron

- 源任务：T-1F2FBCF6；源任务文件 SHA256 为 `7977bf23a93ec394a1415d84b2947c5675af81adfbfb3f93e211d68ed65e6de5`，执行前后未改变。
- 隔离任务：T-8AE0DAFA；Pipeline 26；模型仅在隔离验收中使用 `gpt-5.6-terra`；节点并发 10。
- 实际应用路径：`D:\project\prd-refinement-desktop`；独立 userData 位于 `docs/tmp/acceptance/prd-checklist-preserve-real-26/profile`。
- 首次在 `details-F-001-batch0` 拒绝了越界 evidence ID；内置重试只补失败批次，随后七阶段全部完成。
- 最终状态 `completed`，交付状态 `ready`；34 个功能、200 条需求、3 个待处理事项，无未核查范围。

## 交付包回读

- `checklist.csv`：200 行，列固定为 `feature_id,feature_source,requirement_id,requirement,source_location,check_status,notes`。
- `checklist.xlsx`：需求清单 201 行（含表头）、待处理事项 4 行、阅读说明 5 行；待处理表含建议方案、备选、原文位置、处理状态和用户决定列。
- `pending.json`：3 项开放 blocking 待处理事项，三项均保留完整 `resolutionProposal`，没有伪造用户决定。
- `requirements.json`、manifest、README 和冻结原始资料均存在；原始 HTML 的包内 SHA256 为 `03AA77752B175DEB1FBEB22913071E1DC49BC41926BA53158DE86677683C0FAE`。

## 根因回归

Pipeline 25 曾把跨功能澄清所需的 F-006 需求混入 F-001 的普通 requirements，模型据此产生错误的功能归属问题。Pipeline 26 将其放入独立的 `clarificationContextRequirements`，只允许用于判断待处理事项是否已有答案。真实任务不再出现该错误，也未再出现同一待处理事项被不同功能批次互相判矛盾。

调整和建议采纳边界由自动测试覆盖：采纳结果保存为 `userDecision.status=pending-prd-sync` 和非业务事实的 UserEvidence，不自动新增正式需求；功能组织调整不创造业务事实。
