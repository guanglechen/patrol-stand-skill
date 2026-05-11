---
name: excel-workbook-quality
description: Validate and polish patrol standard Excel workbook outputs. Use whenever the final output is an `.xlsx` workbook or workbook contract quality matters.
---

# Excel Workbook Quality Skill

Use this skill together with `inspection-standard-hierarchy-consultant` whenever the output is a patrol standard workbook.

## Required Workbook Contract
- Final artifact must be `.xlsx`.
- Keep the sheet order fixed:
  1. `巡检标准架构树`
  2. `组织职责`
  3. `覆盖矩阵`
  4. `待确认项`
  5. `引申依据`
  6. `标准清单`
- Preserve the headers documented in `references/workbook-contract.md`.
- Run `python3 scripts/validate_workbook.py <workbook>` before declaring success.

## Quality Rules
- Workbook rows must be reviewable by a business user, not just machine-valid.
- Wider columns should be assigned to longer narrative fields such as `设计理由`, `纳入边界`, `排除边界`, `问题描述`, and inspection item descriptions.
- Compact fields such as `层级`, `节点代号`, `优先级`, and `确认状态` should remain narrow.
- Missing evidence must be represented with `needs_review`, `assumed`, or `sample_only`; never silently mark weak evidence as `confirmed`.
- The main deliverable is the Excel workbook. Trace files and validation reports are supporting artifacts.

## Preferred Flow
1. Build structured case JSON first.
2. Render the workbook with `scripts/render_workbook.py`.
3. Validate with `scripts/validate_workbook.py`.
4. Register the final `.xlsx` plus the validation report as artifacts.
