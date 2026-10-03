# 从Excel到DuckDB搭建教程

## 第一步：盘点数据源

AI助手读取每类文件的文件名、sheet、表头、前20行样例、行数、日期范围和空值情况，形成数据源清单：

| 数据集 | 文件规则 | sheet | 粒度 | 更新频率 | 目标表 |
|---|---|---|---|---|---|
| 月度销售 | `销售_YYYYMM.xlsx` | data | 月份+门店+商品 | 每月 | `fact_sales_monthly` |

## 第二步：建立业务字典

在写代码前确认：

- 字段字典：标准字段名、类型、示例、空值规则、来源字段。
- 指标字典：业务含义、计算公式、可加性、适用粒度。
- 枚举字典：门店、渠道、品牌、状态等标准值及别名。
- 自然键：唯一标识一行业务事实的字段组合。

## 第三步：搭建Python环境

```powershell
python -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

模板依赖：

- `duckdb`：分析型数据库。
- `pandas`：读取和清洗表格。
- `openpyxl`：读取`.xlsx`。
- `mcp`：提供MCP服务。
- `pytest`：自动化验证。

## 第四步：先校验

```powershell
& .\.venv\Scripts\python.exe scripts\import_data.py `
  --source data\示例月度销售.xlsx `
  --validate-only
```

质量报告包含文件哈希、字段完整性、日期解析、自然键重复、金额数量范围和汇总结果。

## 第五步：写入DuckDB

```powershell
& .\.venv\Scripts\python.exe scripts\import_data.py `
  --source data\示例月度销售.xlsx `
  --write-db
```

模板采用目标月份分区替换：先在事务中删除该批次覆盖月份，再写入新数据。其它月份保持原状。

## 第六步：验证数据库

```powershell
& .\.venv\Scripts\python.exe scripts\verify_database.py
```

验证内容：

- 事实表、分析视图和审计表存在。
- 自然键重复数为0。
- 数据库汇总与源Excel汇总一致。
- 月份覆盖和行数符合预期。
- 只读连接可以完成查询。

## 第七步：运行测试

```powershell
& .\.venv\Scripts\python.exe -m pytest tests -q
```

后续新增字段或规则时，先为新规则添加测试样例，再调整导入逻辑并运行全量验证。

## 第八步：接入AI助手

按照`05_MCP与AI助手接入教程.md`启动MCP，并完成状态查询、指标定义和月度销售查询三项验收。
