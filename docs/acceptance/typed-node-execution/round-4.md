# 第四轮：最终构建真实全任务与用户桌面

## 原失败输入的完整任务

2026-09-14 16:07:09–16:13:25（北京时间），通过真实 Electron IPC `restartAnalysis` 在隔离 profile 中重跑原任务冻结输入。用户明确授权仅隔离验收使用 `gpt-5.6-terra`；不修改日常配置，不声称原 Luna 模型容量已恢复。

- 原任务 `T-1F2FBCF6`；新任务 `T-5AEDC682`，Pipeline 22。
- 七阶段全部 completed；8 功能、89 需求、1 澄清；46 成功回执、46 调用。
- `delivery.state=ready`，`unverifiedScopeIds=[]`；待处理事项仍保留，未当作确定需求。
- 原任务 SHA-256 前后相同：`7977bf23a93ec394a1415d84b2947c5675af81adfbfb3f93e211d68ed65e6de5`。
- 冻结来源 hash：`2f860f273c2961e45c59438c79e1945e53e977e867c713f17b22b8b5cc759b0d`。
- 主进程 PID 815004，appPath 为当前仓库；加载主进程构建 hash `41cea4acd6f25de7acf63d1422ad7900cd76f35b8af882629f43b1df2b49b5e5`，执行器 hash `c2977703a53bbf9c545ce7e3bfd76aa9b5118c3813f3ea5b686dcf735b882d36`。
- 已人工查看终态截图：执行完成 100%，本期89条、待处理1项、格式重试0；未出现执行错误提示。

复现配方：`node docs/acceptance/typed-node-execution/scripts/desktop-validation.mjs <原任务JSON> <docs/tmp内独立目录> gpt-5.6-terra`。完整业务文件及截图含原文，仅本地保留在 `docs/tmp/typed-node-execution/desktop-terra-20260914-4/`，不提交Git。交付物独立读取摘要见本轮目录。

## 实际用户实例

交付包独立读取通过：16文件（15个manifest条目及manifest自身），全部字节数/hash一致；JSON、CSV、XLSX均为89条需求，CSV的19字段逐项相符，实施状态仍为todo、验收状态not_run。46个operationId唯一且与实际promptMetrics完全相同。首次读取脚本错误地将JSON按CSV解析，已修正脚本并重跑；没有改动交付数据。证据：`round-4/package-readback.json`，配方：`node docs/acceptance/typed-node-execution/scripts/verify-task-package.mjs <任务JSON> docs/acceptance/typed-node-execution/round-4/package-readback.json`。

先读取用户 profile 的4个任务，均为终态；正常关闭旧主进程160012。通过 `inspect-user-desktop.mjs` 启动真实用户 profile，独立读取 PID422136、当前仓库 appPath 和生产构建 file URL；Runtime 配置文件 hash 前后相同，原4任务仍在。截图人工确认任务中心正常显示，无正在执行的任务。

验证实例关闭后正常重新启动，独立 `Get-CimInstance Win32_Process` 读取新主进程778956，命令为本仓库 `electron.exe .`；不带开发服务器变量。用户实际桌面已运行本轮构建，不仅是隔离验证窗口。没有发布新版安装包或修改历史任务。

## 自动验证再跑

最终执行器错误明细改动后，16:11再次 `npm test`：23文件257测试通过；`npm run typecheck` 和 `git diff --check` 通过。构建及UI契约证据见第三轮。

## 失败历史和结论边界

前两次桌面脚本准备失败分别为 Playwright 主进程动态导入不支持、隔离目录缺少资料包；已改为复制冻结任务并调用产品重新开始入口，没有跳过产品节点。第三次旧构建任务完成，但不作为最终构建证据。第四次上述任务才是最终构建的完整验证。

原失败批次单独复现见第二轮；原Luna容量阻塞见第一轮。全任务输出数量受模型语义组织影响，不与前轮35功能/150需求机械等同；本轮验证的是契约、恢复、执行及交付一致性，不是自然语言零遗漏或业务代码验收。
