# 第一轮：原失败节点回归

## 冻结输入

- 原任务：`T-1F2FBCF6`；原功能：`F-003`；原批次：`details-F-003-batch0`。
- 固定功能 29 个来源，加适用约束共 32 个来源；按原有每批 12 单元与文件边界得到 3 批，首批 12 单元、22 条证据。
- 原诊断只保存输入对象哈希，没有完整请求正文。重建输入 SHA256 与诊断 `requestHash` 均为 `5d6fdab4e6d350a465ed0e0dd00c8bebb87926cc852c74a13316860b6203ffe4`。
- 输入对象得到精确复原；调用指令和结构协议已更新，不能宣称完整旧请求逐字重放。

## 本轮结果

1. 原始损坏响应进入 Codex 结构化解析路径，并经过统一执行器：分类 `protocol`，总计 2 次提交后终止，没有正式结果；通过。
2. 使用原任务 `codex-oauth`、`gpt-5.6-luna`、`low` 快照真实调用：供应商返回模型容量已满，错误类 `RuntimeOperationError`、错误代码 `runtime`；未通过业务回归，不自动换模型或把错误当业务澄清。
3. 原任务文件 SHA256 `7977bf23a93ec394a1415d84b2947c5675af81adfbfb3f93e211d68ed65e6de5`；原诊断文件 SHA256 `48ae22056e3408420f0ceb85cf6b160d8e2d99006ce227779745ae316b993331`；调用前后均未变化。

## 重现与证据

先编译 Electron，再运行：

```powershell
node docs/acceptance/typed-node-execution/scripts/replay-failed-detail.mjs --check
node docs/acceptance/typed-node-execution/scripts/replay-failed-detail.mjs
```

`--check` 零写入；真实运行仅写 `docs/tmp/typed-node-execution/`。本轮目录 `failed-detail-1789372353398-d091320c` 保存去敏 `summary.json`、私有输入、原响应、回执与错误；原文不纳入版本库。以上不是整任务完成或语义零遗漏证明。
