# 第 1 轮验证

日期：2026-09-14

## 已通过

- `npm run typecheck`：通过。
- `npx vitest run tests/source-evidence.spec.ts tests/direct-domain.spec.ts tests/scheduler.spec.ts`：3 个测试文件、47 项测试全部通过。
- 合法配对输出已验证可生成字符串字段、逐项 SourceRef 绑定、派生来源和 `draft` 状态。
- 脱敏旧格式同时包含字符串 behavior、平铺 conditions、内部字段和未知证据时，校验一次返回多个精确路径。
- 调度回归验证首轮多错误会写入结构化诊断，并将全部错误和固定示例交给第二轮；只有第二轮合法完整结果进入后续流程。

## 完整验证

- `npm test`：20 个测试文件、207 项测试全部通过。
- `npm run build`：TypeScript、Vite 生产构建和 Electron 主进程编译通过。
- `npm run verify:premium`：`UI contract smoke check passed`。
- 关闭无运行任务的旧 Electron 进程后重新启动；新进程启动时间为 2026-09-14 13:55，启动日志显示 Vite 服务就绪，编译产物包含 pipeline 19 和配对证据协议。

## 未执行边界

- 未在真实失败任务 `T-8CACEBFC` 上点击“重新开始”。桌面控制通道连续两次未能枚举应用窗口，不能据此猜测操作；原失败任务仍保持失败态且 pipeline 为 18。
- 调度测试已验证重新开始会复用冻结输入、创建独立新任务并保留旧失败任务，但这不替代真实 Runtime 的业务结果验证。
