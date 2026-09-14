# Round 1

## 自动验证

- `npm test`：23 个测试文件、242 项测试通过；新增旧 `title/behavior/sourceUnitIds` 需求的只读渲染测试。
- `npm run typecheck`：通过。
- `npm run build`：通过，Vite 转换 1585 个模块。
- `npm run verify:premium`：通过。
- frontend-design-premium strict audit：0 findings。
- `designmd lint DESIGN.md`：0 errors；现有 6 个未映射颜色 token 警告和 1 项 token 摘要，不是本轮新增错误。

## 实际 Electron

使用日常历史任务 `T-430555BA` 的隔离副本启动当前仓库 Electron，不调用模型、不改写正式 profile：

- “全部需求”显示 49 条旧版需求，首条“批量输入数据集 ID 筛选审核任务”可见，pageErrors=[]。
- 需求表头与首行复选框 X 坐标均为 108；功能表头与首行复选框 X 坐标均为 108。
- 执行记录使用默认折叠的“清单校验明细”，页面不存在“平台检查记录”。
- 运行统计区实际高度 157.33px；1100×720 视口 document 横向溢出为 0。
- 实际截图保存在忽略目录 `docs/tmp/result-workspace-ui/{requirements,execution}.png`，不作为长期仓库附件。

## 本轮修正

首轮窄视口检查发现 `body` 的 1100px 固定最小宽度与竖向滚动条叠加，产生 11px 页面横向溢出。移除文档级固定最小宽度后复验为 0；宽表自身继续由 `.scope-table` 管理横向滚动。
