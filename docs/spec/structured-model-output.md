# 模型结构化输出修复方案

## 问题与根因

真实任务 `T-1F2FBCF6` 的 `details-F-003-batch0` 首轮返回业务字段错误，第二轮修正时返回语法损坏 JSON。当前 Runtime 只用提示词要求 JSON，随后直接 `JSON.parse`，没有使用 Codex CLI 已提供的 `--output-schema`，因此把 JSON 语法正确性错误地交给概率模型保证。

## 修复

1. Runtime 调用支持传入 JSON Schema，并将其交给 Codex 原生结构化输出通道。
2. 逐功能细化节点使用与现有领域校验一致的严格 schema；语法和基础类型由生成端保证，来源引用和业务约束继续由确定性校验负责。
3. Pipeline 升级；新协议只续跑新检查点，未完成任务从冻结输入重新建立任务。
4. 保留两轮业务反馈，但不再用碰运气式重试承担 JSON 语法修复。

## 验证

- Runtime 参数测试与 Scheduler 回归测试。
- typecheck、完整测试、build。
- Codex CLI 真实结构化输出探针。
- 用相同冻结输入建立真实任务，越过原失败节点后再判断整任务结果。
