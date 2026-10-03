# MCP与AI助手接入教程

## MCP在系统中的作用

MCP将数据库能力封装为结构化工具。AI助手负责理解问题、选择工具和组织答案，MCP负责参数校验、业务口径、DuckDB计算和结果上下文。

## 推荐工具设计

| 工具 | 用途 |
|---|---|
| `get_database_status` | 返回数据库版本、更新时间和覆盖范围 |
| `list_datasets` | 返回可查询数据集及默认指标 |
| `get_metric_definition` | 返回指标定义和公式 |
| `query_sales_monthly` | 按月份、门店、产品和品牌查询销售 |
| `execute_safe_sql` | 面向专家场景执行受控只读SQL |

业务高频查询优先使用结构化工具。结构化参数能够稳定限定表、字段、指标和聚合方式。

## 本机stdio接入

先确认模板数据库已生成：

```powershell
& .\.venv\Scripts\python.exe scripts\verify_database.py
```

模板提供`config/ai_assistant_mcp.example.json`。将其中路径替换为教学包在本机的绝对路径，然后运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts\install_ai_assistant.ps1
```

脚本会更新：

```text
%USERPROFILE%\.ai_assistant\mcp.json
```

重启AI助手后，确认`business-duckdb`连接器已启用，并能看到3个工具。

## 验收问题

依次向AI助手提问：

1. `当前数据库覆盖哪些月份和门店？`
2. `GMV和同比的定义是什么？`
3. `查询2026年2月各门店GMV、销量及同比。`
4. `下滑主要来自哪些品牌和商品？`

答案应包含数据库版本、数据表、时间范围、筛选条件、指标口径和查询结果。

## 团队共享升级

团队环境采用常开电脑或服务器运行Streamable HTTP MCP：

```text
同事AI助手
    ↓ 公司网络 + Bearer Token
共享MCP服务
    ↓ 只读连接
已发布DuckDB快照
```

生产配置包含：

- 服务绑定公司内网地址。
- 防火墙仅放行公司网段。
- 每位同事使用独立Token。
- Token支持新增、禁用、恢复、轮换和删除。
- 审计日志记录用户、工具、时间、参数摘要、结果状态和数据库版本。
- 数据库连接使用`read_only=True`并关闭DuckDB外部访问。
- SQL工具采用AST解析、授权表白名单、函数白名单、行数限制和超时控制。
- 查询服务读取不可变快照，更新完成后原子切换版本。

## AI助手回答约定

在连接器说明中写入以下约定：

```text
回答前先调用get_database_status核验覆盖范围。
高频业务查询优先调用结构化工具。
回答中保留database_version、query_context和warnings。
所有金额、数量、人数和比率由工具返回数据计算。
业务归因区分数据库事实与待业务核验项。
```
