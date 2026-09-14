# Markdown 实施检查清单

## 目标

将 Agent 交付包中的 CSV/Excel 工作表收敛为一份可直接勾选的 `implementation.md`。它只承担逐项查漏，不替代原始 PRD，也不承载平台校验状态或代码验收结论。

## 文件契约

```markdown
# 实施检查清单

> 完成一项后，将对应的 `- [ ]` 改为 `- [x]`。实现前仍需阅读 `sources/files/` 中的原始 PRD。

## F-001 活动管理

- [ ] R-001：停用后禁止新增关联。
  - 原文：sources/files/活动管理.md · 第 3 节
```

- 功能顺序和需求顺序与 `requirements.json` 一致。
- 每条本期需求恰好出现一次；功能的 `requirementIds` 是最终归属，兼容历史需求缺少 `featureId` 的只读数据；重复归属、无功能归属或缺少原文时拒绝发布。
- 多个原文位置用同一缩进层级逐条列出。
- 发布前从磁盘回读 `implementation.md`，与确定性生成结果逐字比对，并纳入 manifest 哈希。
- 不再在 Agent 包中生成 `checklist.csv` 和 `checklist.xlsx`；`requirements.json` 保留为只读机器快照。

## 验证

- 中文标点、Markdown 符号和多行需求保持为一个可勾选事项。
- 范围排除后，Markdown 与 `requirements.json` 的需求编号集合一致。
- 真实任务生成的新包只含 `implementation.md`，不存在 CSV/Excel 工作清单。
