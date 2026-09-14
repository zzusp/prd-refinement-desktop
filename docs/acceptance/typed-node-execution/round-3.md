# 第三轮：集成、故障注入与构建

## 自动验证

- `npm test`：23 文件、257 测试通过（2026-09-14 16:06）；无跳过或未处理异常。
- `npm run typecheck`：通过。
- `npm run build`：React/Vite 及 Electron TypeScript 编译通过。
- `npm run verify:premium`：UI contract smoke check passed。
- `git diff --check`：通过。

## 关键反例

- 无效输入、重复来源/证据、悬空证据与倒置范围：零 Runtime 初始化及模型调用。
- 业务候选修正最多2轮，原输入、上次候选、结构化错误保留；transient 2次和protocol 1次重试不随业务修正重置。
- 普通程序 Error / TypeError 不进入业务修正；只有显式 DomainValidationError / DetailEvidenceValidationError 属于候选验收失败。
- 单功能25来源分3批，其中一批失败；重启后仅失败批重跑，调用次数排序为1、1、2，正式需求25项且无重复。
- 并发相同工作单元必须等待原子保存，模型只调用一次；保存失败不会向任何调用者返回成功。
- 同名工作单元不同输入拥有不同操作ID，提示指标与Runtime实际ID一致，避免并行统一节点覆盖Schema文件与用量记录。
- 单目标映射提交额外allocations被拒绝；多目标分配重复目标被拒绝。
- 阻塞级业务澄清仍随正式需求包保留；修正通道认证故障不改写原AuditIssue、不提交补丁或正式包。
- 调整工作单元输入绑定完整projectContextHash，其他功能修改会改变回执身份，避免恢复旧整项目。

## 真实探针

当前13节点Schema原生全量通过，后续details/repair增量2项也通过。供应商子集转换保留等价语义：互斥oneOf→anyOf、optional展开有无分支、根联合封装在result字段；动态映射使用固定字段的allocations数组。详细逐项模型、时间、Schema哈希和失败历史见 `round-1/native-schema-summary.json`。

原失败批次Terra真实验收见round-2；本轮自动验证不代替完整任务和实际桌面运行。
