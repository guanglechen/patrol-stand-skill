#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from contract import SHEET_HEADERS, SHEET_ORDER, blank_sheet_rows, row_dict_to_values
from xlsx_utils import write_workbook


SECTION_KEYS = {
    "巡检标准架构树": "hierarchy_rows",
    "组织职责": "organization_rows",
    "覆盖矩阵": "coverage_rows",
    "待确认项": "clarification_rows",
    "引申依据": "reference_rows",
    "标准清单": "standard_rows",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="把层级优先的 case JSON 渲染成巡检标准工作簿。")
    parser.add_argument("--input", required=True, help="输入 JSON 路径")
    parser.add_argument("--output", required=True, help="输出 XLSX 路径")
    return parser.parse_args()


def load_payload(path: Path) -> dict[str, object]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if "workbook" in data and isinstance(data["workbook"], dict):
        lifted = dict(data)
        lifted.update(data["workbook"])
        return lifted
    return data


def build_sheet_rows(payload: dict[str, object], sheet_name: str) -> list[list[object]]:
    rows = blank_sheet_rows(sheet_name)
    key = SECTION_KEYS[sheet_name]
    section_rows = payload.get(key, [])
    if not isinstance(section_rows, list):
        raise ValueError(f"区段 {key} 必须是列表")
    for row in section_rows:
        if not isinstance(row, dict):
            raise ValueError(f"区段 {key} 中的每一行都必须是对象")
        rows.append(row_dict_to_values(sheet_name, row))
    return rows


def main() -> int:
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    payload = load_payload(input_path)

    sheets = [(sheet_name, build_sheet_rows(payload, sheet_name)) for sheet_name in SHEET_ORDER]
    write_workbook(output_path, sheets)

    summary = {
        sheet_name: max(len(rows) - 1, 0)
        for sheet_name, rows in sheets
    }
    print(f"已写入工作簿：{output_path}")
    print(json.dumps(summary, ensure_ascii=False))
    print(json.dumps({name: len(headers) for name, headers in SHEET_HEADERS.items()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
