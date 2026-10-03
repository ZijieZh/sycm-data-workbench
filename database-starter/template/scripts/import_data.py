# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
from pathlib import Path
import sys

import duckdb
import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = PROJECT_ROOT / "db" / "business.duckdb"
REPORT_DIR = PROJECT_ROOT / "reports"
SHEET_NAME = "data"
REQUIRED_COLUMNS = [
    "统计月份",
    "店铺",
    "商品ID",
    "商品名称",
    "品牌",
    "支付金额",
    "支付件数",
    "支付买家数",
]
NATURAL_KEY = ["统计月份", "店铺", "商品ID"]
NUMERIC_COLUMNS = ["支付金额", "支付件数", "支付买家数"]


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize_month(value: object) -> str | None:
    if pd.isna(value):
        return None
    text = str(value).strip()
    for fmt in ("%Y-%m", "%Y/%m", "%Y%m", "%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m")
        except ValueError:
            continue
    try:
        return pd.to_datetime(value).strftime("%Y-%m")
    except (TypeError, ValueError):
        return None


def read_and_normalize(source: Path) -> pd.DataFrame:
    raw = pd.read_excel(source, sheet_name=SHEET_NAME, dtype=object)
    raw.columns = [str(column).strip().replace("\n", "") for column in raw.columns]
    missing = [column for column in REQUIRED_COLUMNS if column not in raw.columns]
    if missing:
        raise ValueError(f"缺少必需字段：{', '.join(missing)}")

    frame = raw[REQUIRED_COLUMNS].copy()
    frame["统计月份"] = frame["统计月份"].map(normalize_month)
    for column in ("店铺", "商品ID", "商品名称", "品牌"):
        frame[column] = frame[column].map(lambda value: "" if pd.isna(value) else str(value).strip())
    for column in NUMERIC_COLUMNS:
        cleaned = frame[column].map(
            lambda value: str(value).replace(",", "").strip() if not pd.isna(value) else ""
        )
        frame[column] = pd.to_numeric(cleaned, errors="coerce")
    frame["支付件数"] = frame["支付件数"].astype("Int64")
    frame["支付买家数"] = frame["支付买家数"].astype("Int64")
    frame["来源文件"] = source.name
    frame["来源sheet"] = SHEET_NAME
    frame["来源行号"] = range(2, len(frame) + 2)
    return frame


def validate(frame: pd.DataFrame) -> list[str]:
    issues: list[str] = []
    for column in ("统计月份", "店铺", "商品ID"):
        invalid = frame[column].isna() | frame[column].astype(str).str.strip().eq("")
        if invalid.any():
            issues.append(f"关键字段{column}存在{int(invalid.sum())}个空值")
    for column in NUMERIC_COLUMNS:
        if frame[column].isna().any():
            issues.append(f"数值字段{column}存在{int(frame[column].isna().sum())}个无效值")
        negative = frame[column].fillna(0) < 0
        if negative.any():
            issues.append(f"数值字段{column}存在{int(negative.sum())}个负值")
    duplicates = frame.duplicated(NATURAL_KEY, keep=False)
    if duplicates.any():
        issues.append(f"自然键重复行{int(duplicates.sum())}条")
    return issues


def quality_report(source: Path, frame: pd.DataFrame, issues: list[str], digest: str) -> Path:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    months = sorted(value for value in frame["统计月份"].dropna().unique())
    report = REPORT_DIR / f"import_{datetime.now():%Y%m%d_%H%M%S}_quality.md"
    lines = [
        "# 导入质量报告",
        "",
        f"- 源文件：`{source}`",
        f"- SHA256：`{digest}`",
        f"- 目标月份：`{', '.join(months)}`",
        f"- 读取行数：{len(frame):,}",
        f"- 支付金额：{frame['支付金额'].sum():,.2f}",
        f"- 支付件数：{frame['支付件数'].sum():,.0f}",
        f"- 阻断项：{len(issues)}",
        "",
        "## 阻断明细",
        "",
    ]
    lines.extend([f"- {issue}" for issue in issues] or ["- 无"])
    report.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return report


def write_database(db_path: Path, source: Path, frame: pd.DataFrame, digest: str) -> str:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    imported_at = datetime.now()
    batch_id = f"{imported_at:%Y%m%d_%H%M%S}_{digest[:8]}"
    payload = frame.copy()
    payload["导入批次"] = batch_id
    payload["导入时间"] = imported_at
    months = sorted(payload["统计月份"].unique())

    with duckdb.connect(str(db_path)) as connection:
        connection.execute("begin transaction")
        try:
            connection.execute(
                """
                create table if not exists fact_sales_monthly (
                    统计月份 varchar,
                    店铺 varchar,
                    商品ID varchar,
                    商品名称 varchar,
                    品牌 varchar,
                    支付金额 double,
                    支付件数 bigint,
                    支付买家数 bigint,
                    来源文件 varchar,
                    来源sheet varchar,
                    来源行号 bigint,
                    导入批次 varchar,
                    导入时间 timestamp
                )
                """
            )
            connection.execute(
                """
                create table if not exists etl_import_batch (
                    批次ID varchar,
                    源文件 varchar,
                    文件SHA256 varchar,
                    目标月份 varchar,
                    写入行数 bigint,
                    支付金额 double,
                    校验状态 varchar,
                    导入时间 timestamp
                )
                """
            )
            placeholders = ",".join("?" for _ in months)
            connection.execute(
                f"delete from fact_sales_monthly where 统计月份 in ({placeholders})", months
            )
            connection.register("incoming_sales", payload)
            connection.execute("insert into fact_sales_monthly select * from incoming_sales")
            connection.execute(
                """
                create or replace view mart_sales_monthly as
                select * from fact_sales_monthly
                """
            )
            connection.execute(
                "insert into etl_import_batch values (?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    batch_id,
                    str(source.resolve()),
                    digest,
                    ";".join(months),
                    len(payload),
                    float(payload["支付金额"].sum()),
                    "通过",
                    imported_at,
                ],
            )
            connection.execute("commit")
        except Exception:
            connection.execute("rollback")
            raise
    return batch_id


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="校验并导入月度销售Excel")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--validate-only", action="store_true")
    mode.add_argument("--write-db", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = args.source.resolve()
    if not source.is_file():
        raise FileNotFoundError(f"源文件不存在：{source}")
    digest = file_sha256(source)
    frame = read_and_normalize(source)
    issues = validate(frame)
    report = quality_report(source, frame, issues, digest)
    print(f"QualityReport={report}")
    print(f"Rows={len(frame)}")
    print(f"BlockingIssues={len(issues)}")
    if issues:
        return 1
    if args.write_db:
        batch_id = write_database(args.db.resolve(), source, frame, digest)
        print(f"BatchId={batch_id}")
        print(f"Database={args.db.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
