# 生参数据工作台

从生意参谋页面取数、文件归档、质量校验、DuckDB 建库，到 BI 经营分析和周会输出的一站式开源工作流。

> 公开版本统一使用“生参旗舰店”和虚构经营数据，不包含真实店铺名称、店铺 ID、账号凭证、经营数字或本机业务路径。

[在线体验](https://zijiezh.github.io/sycm-data-workbench/) · [下载最新版插件](https://github.com/ZijieZh/sycm-data-workbench/releases/latest)

## 项目包含什么

| 模块 | 版本 | 用途 |
|---|---:|---|
| 生参通用取数 | 0.1.12 | 店铺、商品、品类、客户等多维取数；队列、暂停、续跑和归档 |
| 竞店流失取数 | 0.2.6 | 日期范围内的流失店铺与流向商品分页采集 |
| 竞品流失取数 | 0.3.5 | 指定商品或全店商品的浏览、搜索流失竞品采集 |
| DuckDB 教学包 | 可运行模板 | Excel/CSV 盘点、校验、事实表、分析表、审计和只读 MCP |
| BI 在线演示 | 静态脱敏版 | 经营总览、多维归因、商品诊断和数据治理交互演示 |

## 完整链路

```text
生意参谋可见页面
    ↓ Chrome 扩展
Excel / CSV 原始导出
    ↓ 批次盘点与写前校验
DuckDB fact_* 事实表
    ↓ 指标字典与业务标签
DuckDB mart_* 分析表
    ↓ 只读查询服务
BI 经营工作台
    ↓
经营诊断与周会数据包
```

## 安装取数插件

1. 从 [Releases](https://github.com/ZijieZh/sycm-data-workbench/releases/latest) 下载所需 ZIP 并解压。
2. 打开 Chrome 的 `chrome://extensions`。
3. 开启“开发者模式”，点击“加载已解压的扩展程序”。
4. 选择解压后的插件目录，其中应直接包含 `manifest.json`。
5. 登录生意参谋并进入插件对应页面，先用短日期范围验证结果。

三款插件均使用 Manifest V3，只操作页面可见控件。它们不会读取 Cookie、账号密码或令牌，也不包含验证码识别、反检测或风控绕过能力。平台页面变化后应重新验证，不应把本仓库视为平台接口承诺。

## 搭建 DuckDB 数据库

进入 [`database-starter`](database-starter/README.md)，按顺序阅读 00—06 文档。模板中的 Excel 与数据库均为虚构数据，可以直接运行：

```powershell
cd database-starter\template
python -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
& .\.venv\Scripts\python.exe scripts\import_data.py --source data\示例月度销售.xlsx --validate-only
& .\.venv\Scripts\python.exe scripts\import_data.py --source data\示例月度销售.xlsx --write-db
& .\.venv\Scripts\python.exe scripts\verify_database.py
& .\.venv\Scripts\python.exe -m pytest tests -q
```

模板坚持四项原则：源文件不覆盖、校验先于写库、事实层与分析层分离、查询服务默认只读。

## 本地查看展示网页

网页不依赖构建工具：

```powershell
cd docs
python -m http.server 8765 --bind 127.0.0.1
```

然后打开 `http://127.0.0.1:8765/`。BI 演示数据直接内嵌在 [`docs/app.js`](docs/app.js)，全部为虚构数据。

## 目录

```text
sycm-data-workbench/
├─ docs/                         # GitHub Pages 展示页与交互 BI 演示
├─ extensions/
│  ├─ general-collector/         # 生参通用取数 v0.1.12
│  ├─ store-loss-collector/      # 竞店流失 v0.2.6
│  └─ product-loss-collector/    # 竞品流失 v0.3.5
├─ database-starter/             # DuckDB 教学文档与可运行模板
└─ releases/                     # 本地构建的脱敏 ZIP
```

## 数据与安全边界

- 不提交真实经营数据、下载产物、账号凭证、Token、Cookie 或本机业务路径。
- 插件触发页面可见操作，出现风控或验证码时应立即停止并人工处理。
- BI 演示中的店铺、商品、金额、趋势和质量得分均为虚构。
- 商品粒度人数通常是链接级累加口径，不能自动解释为全店去重人数。
- 正式入库前必须核对字段、时间范围、自然键、汇总勾稽和业务口径。

## 许可

代码使用 [MIT License](LICENSE)。平台名称和商标归各自权利人所有。
