# 更新日志

本文件记录需求细化平台各版本的重要变更。

## [未发布]

### 新增

- Agent 交付包增加 `implementation.csv`，逐项记录需求实施状态、代码依据、验收状态、实跑证据和阻塞原因。
- 交付包 README 提供编码 Agent 的完整执行、续作和完成判定步骤。

### 完善

- 全部分析节点改用同源输入、候选及正式结果契约；图片读取、建议生成与后续调整也通过统一执行器，取消按标题猜测节点和自由文本 JSON 通道。
- 功能细化按批保存成功回执，重启后只补失败批次；候选修正携带原输入、上次候选和结构化问题，传输重试与业务修正分别计数。
- Codex 只有收到完整结束事件才提交结果，取消与超时等待旧进程关闭；DSH 缺少结构化能力时明确预检失败。新任务使用 Pipeline 22，旧任务需从冻结资料重新开始。
- 任务交付状态与需求包统一：业务待确认随包保留，不阻止需求导出；未通过平台核查仍为草稿。
- 发布前独立解析并核对 CSV 的列定义、需求全集和只读业务字段，包格式版本参与交付目录身份计算。
- 逐功能细化改为内容与证据配对输出，由程序生成内部来源字段；一次反馈全部可定位的结构问题，避免条件与证据平行数组错位后才暴露内部校验错误。
- 移除所有平台估算 token 硬限制及阈值拆批，估算值只用于诊断；依据核查按输入指纹保存成功或失败状态，失败不会再伪装成业务审计问题，重试会真正补跑。
- 逐功能细化通过 Codex 原生 JSON Schema 参数固化输出结构，不再依赖提示词保证 JSON 语法正确；来源引用和业务字段仍由平台确定性校验。

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

[0.1.4]: https://github.com/tzt-company/prd-refinement-desktop/releases/tag/v0.1.4
[0.1.3]: https://github.com/tzt-company/prd-refinement-desktop/releases/tag/v0.1.3
[0.1.2]: https://github.com/tzt-company/prd-refinement-desktop/releases/tag/v0.1.2
[0.1.1]: https://github.com/tzt-company/prd-refinement-desktop/releases/tag/v0.1.1
[0.1.0]: https://github.com/tzt-company/prd-refinement-desktop/releases/tag/v0.1.0
