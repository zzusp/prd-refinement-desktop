# 最小 Agent 交付包

## 目标

Agent 交付包只为编码时查漏服务。编码 Agent 必须阅读冻结的原始 PRD，再用一份可勾选清单确认功能和需求是否遗漏；不输出重复导航、平台过程状态或解析中间数据。

## 文件契约

- `README.md`：只说明阅读顺序和勾选方法。
- `agent-checklist.md`：唯一实施清单，按功能分组，每条需求一个复选框并带原文位置。
- `sources/files/`：冻结的原始 PRD 与补充资料。
- `manifest.json`：机器完整性校验信息，不承载实施说明。

删除以下重复产物：

- `features/*.md`：与 `agent-checklist.md` 重复。
- `requirements.json`：不再把清单之外的机器快照交给编码 Agent。
- `sources/index.json`、`sources/assets/`：属于平台解析中间数据；原始文件已完整保存在 `sources/files/`。

## 校验

- `agent-checklist.md` 中的需求编号必须与本期需求一一对应。
- 所有原始文件逐文件复制并校验哈希。
- manifest 覆盖除自身外的全部文件，发布前逐文件回读校验。
- 任务状态变化和导出期间数据变化仍在平台内部 fail closed，不写入面向编码 Agent 的说明。
