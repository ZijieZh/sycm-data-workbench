# DuckDB AI业务数据库教学包

本教学包供 AI助手 Agent 阅读和执行。完成后，将得到一套可持续更新、可校验、可由AI查询的业务数据库。

## 学习成果

- 将分散Excel整理为标准数据源目录。
- 使用DuckDB建立事实表、分析表和导入审计表。
- 固化指标定义、字段标准和自然键。
- 在写库前完成完整性、重复、冲突和汇总勾稽校验。
- 通过MCP向AI助手提供只读业务查询工具。
- 建立月度更新、备份、发布和团队权限管理流程。

## 阅读顺序

1. `00_给AI先读.md`
2. `01_系统架构与设计原则.md`
3. `02_从Excel到DuckDB搭建教程.md`
4. `03_数据建模与字段标准化.md`
5. `04_数据质量校验清单.md`
6. `05_MCP与AI助手接入教程.md`
7. `06_日常更新和运维流程.md`

`template`目录是一套可运行的月度销售示例。AI助手应先运行示例，再根据用户的实际文件调整字段和规则。

## 快速运行模板

在PowerShell中执行：

```powershell
cd template
python -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
& .\.venv\Scripts\python.exe scripts\import_data.py --source data\示例月度销售.xlsx --validate-only
& .\.venv\Scripts\python.exe scripts\import_data.py --source data\示例月度销售.xlsx --write-db
& .\.venv\Scripts\python.exe scripts\verify_database.py
```

验证通过后，按`05_MCP与AI助手接入教程.md`接入AI助手。

## 文件安全

教学包中的示例数据均为虚构数据。正式项目采用独立工作目录、只读查询账号、独立Token、审计日志和定期快照。
