# -*- coding: utf-8 -*-
from __future__ import annotations

from datetime import datetime
import hashlib
import os
from pathlib import Path
from typing import Any

import duckdb
from mcp.server.fastmcp import FastMCP


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.environ.get("BUSINESS_DB_PATH", PROJECT_ROOT / "db" / "business.duckdb"))
ALLOWED_GROUPS = {"统计月份", "店铺", "商品ID", "商品名称", "品牌"}
METRICS = {
    "GMV": "sum(支付金额)",
    "销量": "sum(支付件数)",
    "商品成交人数合计": "sum(支付买家数)",
}

mcp = FastMCP(
    "business-duckdb",
    instructions=(
        "回答前先调用get_database_status核验覆盖范围。"
        "月度销售问题调用query_sales_monthly。"
        "回答保留database_version、query_context和warnings。"
    ),
)


def connect() -> duckdb.DuckDBPyConnection:
    if not DB_PATH.is_file():
        raise FileNotFoundError(f"数据库不存在：{DB_PATH}")
    connection = duckdb.connect(str(DB_PATH), read_only=True)
    connection.execute("set enable_external_access = false")
    connection.execute("set threads = 2")
    connection.execute("set memory_limit = '512MB'")
    return connection


def database_version() -> str:
    stat = DB_PATH.stat()
    return hashlib.sha256(f"{stat.st_size}:{stat.st_mtime_ns}".encode("ascii")).hexdigest()[:16]


def json_rows(cursor: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    columns = [item[0] for item in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


@mcp.tool(description="查看数据库版本、更新时间和月度销售覆盖范围。")
def get_database_status() -> dict:
    with connect() as connection:
        row = connection.execute(
            "select count(*), min(统计月份), max(统计月份), count(distinct 店铺) from mart_sales_monthly"
        ).fetchone()
    return {
        "database_version": database_version(),
        "database_modified_at": datetime.fromtimestamp(DB_PATH.stat().st_mtime).isoformat(),
        "coverage": {
            "row_count": int(row[0]),
            "min_month": row[1],
            "max_month": row[2],
            "store_count": int(row[3]),
        },
    }


@mcp.tool(description="查询GMV、销量、成交人数和同比的统一定义。")
def get_metric_definition(metric: str) -> dict:
    definitions = {
        "GMV": {"field": "支付金额", "formula": "SUM(支付金额)"},
        "销量": {"field": "支付件数", "formula": "SUM(支付件数)"},
        "商品成交人数合计": {
            "field": "支付买家数",
            "formula": "SUM(支付买家数)",
            "note": "商品粒度人数可能跨商品重复",
        },
        "同比": {"formula": "本期值 / 去年同期值 - 1", "zero_base": "同期为0时返回空值"},
    }
    return {"metric": metric, "definition": definitions.get(metric), "available": list(definitions)}


def previous_year_month(month: str) -> str:
    return f"{int(month[:4]) - 1:04d}{month[4:]}"


def comparison_rows(
    current: list[dict[str, Any]],
    prior: list[dict[str, Any]],
    groups: list[str],
    metrics: list[str],
) -> list[dict[str, Any]]:
    def current_key(row: dict[str, Any]) -> tuple[Any, ...]:
        return tuple(row[group] for group in groups)

    def prior_key(row: dict[str, Any]) -> tuple[Any, ...]:
        values = []
        for group in groups:
            value = row[group]
            if group == "统计月份":
                value = f"{int(value[:4]) + 1:04d}{value[4:]}"
            values.append(value)
        return tuple(values)

    prior_index = {prior_key(row): row for row in prior}
    output = []
    for row in current:
        matched = prior_index.get(current_key(row), {})
        result = {group: row[group] for group in groups}
        for metric in metrics:
            current_value = row.get(metric)
            prior_value = matched.get(metric)
            result[f"{metric}_本期"] = current_value
            result[f"{metric}_同期"] = prior_value
            result[f"{metric}_同比"] = (
                current_value / prior_value - 1
                if current_value is not None and prior_value not in (None, 0)
                else None
            )
        output.append(result)
    return output


def aggregate(
    connection: duckdb.DuckDBPyConnection,
    months: list[str],
    stores: list[str] | None,
    groups: list[str],
    metrics: list[str],
) -> list[dict[str, Any]]:
    select_parts = [f'"{group}"' for group in groups]
    select_parts.extend(f"{METRICS[metric]} as \"{metric}\"" for metric in metrics)
    clauses = [f"统计月份 in ({','.join('?' for _ in months)})"]
    parameters: list[Any] = list(months)
    if stores:
        clauses.append(f"店铺 in ({','.join('?' for _ in stores)})")
        parameters.extend(stores)
    group_sql = ", ".join(f'"{group}"' for group in groups)
    sql = f"select {', '.join(select_parts)} from mart_sales_monthly where {' and '.join(clauses)}"
    if groups:
        sql += f" group by {group_sql} order by {group_sql}"
    return json_rows(connection.execute(sql, parameters))


@mcp.tool(description="按月份、门店、品牌和商品查询月度销售，可计算自然月同比。")
def query_sales_monthly(
    start_month: str,
    end_month: str,
    stores: list[str] | None = None,
    group_by: list[str] | None = None,
    metrics: list[str] | None = None,
    comparison: str = "none",
) -> dict:
    start = datetime.strptime(start_month, "%Y-%m")
    end = datetime.strptime(end_month, "%Y-%m")
    if start > end:
        raise ValueError("开始月份应早于或等于结束月份")
    groups = group_by or ["统计月份", "店铺"]
    invalid_groups = sorted(set(groups) - ALLOWED_GROUPS)
    if invalid_groups:
        raise ValueError(f"分组字段未获授权：{', '.join(invalid_groups)}")
    selected_metrics = metrics or ["GMV", "销量"]
    invalid_metrics = sorted(set(selected_metrics) - set(METRICS))
    if invalid_metrics:
        raise ValueError(f"指标未获授权：{', '.join(invalid_metrics)}")
    if comparison not in {"none", "yoy"}:
        raise ValueError("comparison支持none或yoy")

    periods = []
    cursor = start
    while cursor <= end:
        periods.append(cursor.strftime("%Y-%m"))
        cursor = datetime(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)

    with connect() as connection:
        current = aggregate(connection, periods, stores, groups, selected_metrics)
        if comparison == "yoy":
            prior_periods = [previous_year_month(month) for month in periods]
            prior = aggregate(connection, prior_periods, stores, groups, selected_metrics)
        else:
            prior = []

    warnings = []
    if "商品成交人数合计" in selected_metrics:
        warnings.append("商品成交人数合计可能跨商品重复")
    return {
        "database_version": database_version(),
        "query_context": {
            "table": "mart_sales_monthly",
            "start_month": start_month,
            "end_month": end_month,
            "stores": stores or "全部",
            "group_by": groups,
            "metrics": selected_metrics,
            "comparison": comparison,
        },
        "current": current,
        "prior_year": prior,
        "comparison_rows": (
            comparison_rows(current, prior, groups, selected_metrics)
            if comparison == "yoy"
            else []
        ),
        "warnings": warnings,
    }


if __name__ == "__main__":
    mcp.run(transport="stdio")
