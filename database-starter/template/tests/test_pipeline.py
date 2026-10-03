# -*- coding: utf-8 -*-
from pathlib import Path
import sys

import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from scripts.import_data import normalize_month, read_and_normalize, validate


def test_normalize_month_formats():
    assert normalize_month("2026-07") == "2026-07"
    assert normalize_month("2026/07") == "2026-07"
    assert normalize_month("202607") == "2026-07"


def test_sample_source_passes_validation():
    source = PROJECT_ROOT / "data" / "示例月度销售.xlsx"
    frame = read_and_normalize(source)
    assert len(frame) == 24
    assert validate(frame) == []
    assert frame["统计月份"].min() == "2025-01"
    assert frame["统计月份"].max() == "2026-02"


def test_duplicate_natural_key_is_blocking():
    source = PROJECT_ROOT / "data" / "示例月度销售.xlsx"
    frame = read_and_normalize(source)
    duplicated = pd.concat([frame, frame.iloc[[0]]], ignore_index=True)
    issues = validate(duplicated)
    assert any("自然键重复" in issue for issue in issues)
