# 数据字典

## fact_sales_monthly

粒度：统计月份 + 店铺 + 商品ID。

| 字段 | 类型 | 含义 |
|---|---|---|
| 统计月份 | VARCHAR | `YYYY-MM` |
| 店铺 | VARCHAR | 标准店铺名称 |
| 商品ID | VARCHAR | 商品唯一标识 |
| 商品名称 | VARCHAR | 商品标题 |
| 品牌 | VARCHAR | 标准品牌名称 |
| 支付金额 | DOUBLE | 当月支付GMV |
| 支付件数 | BIGINT | 当月支付件数 |
| 支付买家数 | BIGINT | 商品粒度支付买家数 |
| 来源文件 | VARCHAR | Excel文件名 |
| 来源sheet | VARCHAR | Excel sheet名 |
| 来源行号 | BIGINT | Excel中的数据行号 |
| 导入批次 | VARCHAR | 导入批次ID |
| 导入时间 | TIMESTAMP | 写库时间 |

## mart_sales_monthly

月度销售默认分析视图，当前直接读取`fact_sales_monthly`。正式项目可在该层固化去重、状态筛选、供应商合并和业务归一化。

## etl_import_batch

记录批次ID、源文件、SHA256、目标月份、行数、金额、校验状态和导入时间。
