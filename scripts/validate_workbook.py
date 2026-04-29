#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from contract import (
    ALLOWED_CONFIRMATION_STATES,
    LEVEL_ORDER,
    SHEET_HEADERS,
    SHEET_ORDER,
    normalize_text,
    row_values_to_dict,
)
from xlsx_utils import read_workbook


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="校验层级优先的巡检标准工作簿。")
    parser.add_argument("workbook", help="工作簿路径")
    return parser.parse_args()


def split_labels(value: str) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in re.split(r"[、,，;/；]+", value) if item.strip()]


def main() -> int:
    args = parse_args()
    workbook_path = Path(args.workbook).expanduser().resolve()
    sheets = read_workbook(workbook_path)

    errors: list[str] = []
    warnings: list[str] = []

    actual_order = list(sheets.keys())
    if actual_order != SHEET_ORDER:
        errors.append(f"sheet 顺序不匹配：期望 {SHEET_ORDER}，实际为 {actual_order}")

    for sheet_name in SHEET_ORDER:
        if sheet_name not in sheets:
            errors.append(f"缺少 sheet：{sheet_name}")
            continue
        rows = sheets[sheet_name]
        if not rows:
            errors.append(f"sheet 为空：{sheet_name}")
            continue
        actual_headers = [normalize_text(value) for value in rows[0][: len(SHEET_HEADERS[sheet_name])]]
        expected_headers = SHEET_HEADERS[sheet_name]
        if actual_headers != expected_headers:
            errors.append(f"{sheet_name} 表头不匹配：期望 {expected_headers}，实际为 {actual_headers}")

    hierarchy_rows = [
        row_values_to_dict("巡检标准架构树", row)
        for row in sheets.get("巡检标准架构树", [])[1:]
        if any(normalize_text(cell) for cell in row)
    ]
    name_index: dict[str, dict[str, str]] = {}
    for row in hierarchy_rows:
        level = row["层级"]
        name = row["节点名称"]
        code = row["节点代号"]
        state = row["确认状态"]
        if level not in LEVEL_ORDER:
            errors.append(f"未知层级：{level}（{name}）")
        if not name:
            errors.append("存在节点名称为空的层级行")
            continue
        if name in name_index:
            errors.append(f"Duplicate 节点名称: {name}")
        name_index[name] = row
        if not code:
            warnings.append(f"层级节点缺少节点代号：{name}")
        if state and state not in ALLOWED_CONFIRMATION_STATES:
            errors.append(f"节点 {name} 使用了不支持的确认状态：{state}")

    for row in hierarchy_rows:
        level = row["层级"]
        name = row["节点名称"]
        parent = row["父节点"]
        if level == "L0":
            continue
        if not parent:
            errors.append(f"层级节点 {name} 缺少父节点")
            continue
        if parent not in name_index:
            errors.append(f"层级节点 {name} 引用了未知父节点：{parent}")
            continue
        parent_level = name_index[parent]["层级"]
        if LEVEL_ORDER.get(parent_level, -99) != LEVEL_ORDER.get(level, 99) - 1:
            errors.append(
                f"层级节点 {name} 的父层级非法：父层级 {parent_level}，子层级 {level}"
            )

    l1_names = [row["节点名称"] for row in hierarchy_rows if row["层级"] == "L1"]
    if not l1_names:
        errors.append("未发现任何 L1 节点")

    organization_rows = [
        row_values_to_dict("组织职责", row)
        for row in sheets.get("组织职责", [])[1:]
        if any(normalize_text(cell) for cell in row)
    ]
    covered_l1_from_org: set[str] = set()
    for row in organization_rows:
        labels = split_labels(row["对应一级分类"])
        if "全部" in labels:
            covered_l1_from_org.update(l1_names)
        covered_l1_from_org.update(label for label in labels if label != "全部")
    for l1_name in l1_names:
        if l1_name not in covered_l1_from_org:
            errors.append(f"没有任何组织职责行映射到该 L1 类别：{l1_name}")

    coverage_rows = [
        row_values_to_dict("覆盖矩阵", row)
        for row in sheets.get("覆盖矩阵", [])[1:]
        if any(normalize_text(cell) for cell in row)
    ]
    covered_l1_from_matrix = {row["对应L1"] for row in coverage_rows if row["对应L1"]}
    for l1_name in l1_names:
        if l1_name not in covered_l1_from_matrix:
            errors.append(f"没有任何覆盖矩阵行映射到该 L1 类别：{l1_name}")
    for row in coverage_rows:
        if not row["覆盖状态"]:
            errors.append(f"覆盖矩阵行缺少覆盖状态：{row}")
        if not row["对应L2"]:
            warnings.append(f"覆盖矩阵行缺少对应L2：{row}")

    summary = {
        "errors": len(errors),
        "warnings": len(warnings),
        "hierarchy_rows": len(hierarchy_rows),
        "organization_rows": len(organization_rows),
        "coverage_rows": len(coverage_rows),
    }
    print(json.dumps(summary, ensure_ascii=False))
    for message in errors:
        print(f"错误：{message}")
    for message in warnings:
        print(f"警告：{message}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
