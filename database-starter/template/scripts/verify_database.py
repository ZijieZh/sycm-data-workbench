# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
from pathlib import Path

import duckdb


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = PROJECT_ROOT / "db" / "business.duckdb"


def verify(db_path: Path) -> dict:
    required = {"fact_sales_monthly", "mart_sales_monthly", "etl_import_batch"}
    with duckdb.connect(str(db_path), read_only=True) as connection:
        connection.execute("set enable_external_access = false")
        tables = {row[0] for row in connection.execute("show tables").fetchall()}
        missing = sorted(required - tables)
        if missing:
            raise RuntimeError(f"缺少数据库对象：{', '.join(missing)}")
        duplicate_count = connection.execute(
            """
            select count(*) from (
                select 统计月份, 店铺, 商品ID
                from fact_sales_monthly
                group by all
                having count(*) > 1
            )
            """
        ).fetchone()[0]
        if duplicate_count:
            raise RuntimeError(f"自然键重复组合数：{duplicate_count}")
        row = connection.execute(
            """
            select count(*), min(统计月份), max(统计月份),
                   sum(支付金额), sum(支付件数)
            from mart_sales_monthly
            """
        ).fetchone()
        batch_count = connection.execute("select count(*) from etl_import_batch").fetchone()[0]
    return {
        "rows": int(row[0]),
        "min_month": row[1],
        "max_month": row[2],
        "gmv": float(row[3]),
        "units": int(row[4]),
        "batch_count": int(batch_count),
        "duplicate_keys": int(duplicate_count),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="验证教学模板数据库")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args()
    result = verify(args.db.resolve())
    for key, value in result.items():
        print(f"{key}={value}")
    print("Verification=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
