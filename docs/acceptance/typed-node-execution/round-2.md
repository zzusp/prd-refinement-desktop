# 第二轮：原节点隔离 Terra 回归

## 范围与差异

用户明确批准仅隔离验收将模型替换为 Terra。本轮命令显式传参，不存在自动模型降级：

```powershell
node docs/acceptance/typed-node-execution/scripts/replay-failed-detail.mjs --model gpt-5.6-terra
```

固定输入仍为 `T-1F2FBCF6` 的 `details-F-003-batch0`，12 个来源、22 条证据。重建输入 SHA256 与原诊断输入哈希均为 `5d6fdab4e6d350a465ed0e0dd00c8bebb87926cc852c74a13316860b6203ffe4`。

原模型为 `gpt-5.6-luna`，本轮有效模型为 `gpt-5.6-terra`，推理强度保持 `low`。新节点指令和 Schema 不等同旧请求正文；本轮通过不代表原 Luna 容量问题已经恢复。

## 实跑与独立读回

- 原损坏响应协议回归：`protocol`，精确 2 次调用后停止，通过。
- 真实 Terra 生成：1 次模型调用，0 次业务修正、0 次协议重试、0 次传输重试。
- 候选通过 canonical Proposal、证据物化、`acceptDirectDetails(..., true)` 领域验收和正式 Result 校验。
- 正式输出为 5 条需求、1 条澄清；成功回执独立读回状态 `succeeded`。
- `result.json` SHA256：`ac224dc02ec0986751c68d984aec44d89f54d55fba9777a8615d1037d4f49653`。
- 原任务及原诊断调用前后 SHA256 均不变；未修改正式 Runtime 配置或历史记录。

私有证据保存在 `docs/tmp/typed-node-execution/failed-detail-1789372524456-6369f21e/`，包括 `summary.json`、`receipts.json`、`result.json` 和冻结输入；不将 PRD 原文提交版本库。第一轮 Luna 容量失败记录保留。

以上证明原失败节点固定输入在新协议下通过结构、引用与领域验收，不等同整任务完成、桌面验证或语义零遗漏。
