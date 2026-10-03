# 业务数据库AI协作规则

进入项目后依次阅读本文件、`docs/DATA_DICTIONARY.md`和`docs/METRIC_DICTIONARY.md`。

## 项目位置

- DuckDB：`db/business.duckdb`
- 源数据：`data/incoming`
- 质量报告：`reports`
- 查询输出：`exports`

## 默认口径

- GMV：`支付金额`
- 销量：`支付件数`
- 成交人数：`支付买家数`
- 默认同比：自然月同比
- 月度查询表：`mart_sales_monthly`

## 查询规则

- 每次查询先核验实际日期范围和对象值。
- 普通查询使用DuckDB只读连接。
- 同比同时核验本期与同期完整性。
- 比率和均价使用汇总分子分母重算。
- 输出包含数据表、筛选条件、时间范围、计算公式和数据库版本。

## 更新规则

- 先运行`--validate-only`。
- 质量报告阻断项为0后运行`--write-db`。
- 更新完成后运行测试、数据库验证并生成快照。
