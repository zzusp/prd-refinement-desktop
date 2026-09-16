# 更新日志

本文件记录需求细化平台各版本的重要变更。

## [未发布]

## [0.1.6] - 2026-09-16

### 新增

- 应用顶部显示当前版本，Runtime 配置页支持手动检查 GitHub 最新正式版本。
- 任务详情新增“资料包”页签，可查看本次分析冻结的 PRD、补充资料和提示词。
- 调整结果时可复制当前版本资料，更换主 PRD、增删补充文件或目录并完整重新分析；更新页默认展示当前版本资料和提示词。

### 完善

- 结果列表将当前功能筛选、搜索、周期范围与批量操作按层级重新组织，减少重复筛选和视觉拥挤。
- 批量范围操作栏明确区分当前页选择和当前筛选范围，降低误操作风险。

## [0.1.5] - 2026-09-15

### 新增

- 执行图按阶段显示进行中与完成后的产出摘要，便于了解每一步实际生成了什么。
- 结果页 Tab 以徽章显示功能与需求总数，从功能进入需求清单时显示可清除的紧凑筛选状态。

### 完善

- Agent 实施清单更名为 `agent-checklist.md`，只保留按功能分组的需求复选项和必要的原始资料入口，移除重复来源、状态说明及中间解析产物。
- 任务完成或范围调整后自动生成当前版本交付包，不再要求用户手动执行“生成交付包”。
- 结果页移除重复标题、检查状态和平台检查明细，将结果调整入口移至顶部。
- 执行图取消独立耗时空列，统一使用“总耗时”口径；任务级耗时与用量默认折叠，展开后直接显示节点成本分布。
- `agent-checklist.md` 的原始资料链接保留中文与空格，不再输出 URL 转码后的文件名。

## [0.1.4] - 2026-09-14

### 修复

- 安装包文件名改用稳定 ASCII 名称，避免 GitHub attachment 接口改写中文文件名并导致资产标签恢复失败。

## [0.1.3] - 2026-09-14

### 修复

- 使用固定版本的 Release Action 上传安装包，兼容 GitHub 当前 attachment 上传接口。

## [0.1.2] - 2026-09-14

### 修复

- 为无源码签出目录的 Release job 显式提供 GitHub 仓库上下文，确保双平台构建成功后能创建 Release。

## [0.1.1] - 2026-09-14

### 修复

- 明确分离安装包构建与 GitHub Release 发布，避免 tag 构建时 `electron-builder` 因自动发布且缺少令牌而中断资产上传。

## [0.1.0] - 2026-09-14

### 新增

- 提供 Windows 与 macOS 桌面端应用及安装包。
- 支持 HTML、DOC、DOCX、PDF、Markdown、TXT、图片及目录资料导入。
- 提供多任务并行、检查点恢复、失败续跑和任务归档管理。
- 支持 Codex CLI 与 DSH Runtime，并可按执行节点配置模型和推理深度。
- 生成带来源追溯的 JSON、Markdown、Excel 和原文索引交付包。

### 完善

- 收敛为原文建账、功能候选识别、功能清单统一、逐功能细化、产物依据核查、有据修正、交付七阶段流程。
- 区分阻塞、建议、可忽略三级澄清，并将执行状态与需求交付状态分开。
- 完善来源证据绑定、输入预算、审计返工、并发调度和模型用量展示。
- 统一本地临时产物、验收证据和正式应用数据的目录边界。

[0.1.6]: https://github.com/zzusp/prd-refinement-desktop/releases/tag/v0.1.6
[0.1.5]: https://github.com/zzusp/prd-refinement-desktop/releases/tag/v0.1.5
[0.1.4]: https://github.com/tzt-company/prd-refinement-desktop/releases/tag/v0.1.4
[0.1.3]: https://github.com/tzt-company/prd-refinement-desktop/releases/tag/v0.1.3
[0.1.2]: https://github.com/tzt-company/prd-refinement-desktop/releases/tag/v0.1.2
[0.1.1]: https://github.com/tzt-company/prd-refinement-desktop/releases/tag/v0.1.1
[0.1.0]: https://github.com/tzt-company/prd-refinement-desktop/releases/tag/v0.1.0
