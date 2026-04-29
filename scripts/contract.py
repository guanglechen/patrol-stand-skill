from __future__ import annotations

from typing import Iterable


SHEET_ORDER = [
    "巡检标准架构树",
    "组织职责",
    "覆盖矩阵",
    "待确认项",
    "引申依据",
    "标准清单",
]

SHEET_HEADERS = {
    "巡检标准架构树": [
        "层级",
        "父节点",
        "节点名称",
        "节点代号",
        "节点类型",
        "覆盖对象",
        "设计理由",
        "纳入边界",
        "排除边界",
        "责任专业",
        "参考依据",
        "确认状态",
    ],
    "组织职责": [
        "部门/角色",
        "职责边界",
        "对应一级分类",
        "对应二级类别",
        "巡检责任",
        "整改责任",
        "审核责任",
        "来源",
    ],
    "覆盖矩阵": [
        "业务域",
        "专业",
        "对象域",
        "风险场景",
        "对应L1",
        "对应L2",
        "覆盖状态",
        "缺口说明",
    ],
    "待确认项": [
        "问题类型",
        "问题描述",
        "影响层级",
        "当前假设",
        "需要用户补充",
        "优先级",
        "状态",
    ],
    "引申依据": [
        "标准编号",
        "标准名称",
        "关联系统",
        "关联系统/对象",
        "来源URL",
        "说明",
    ],
    "标准清单": [
        "一级分类",
        "系统属性",
        "适用设备类别",
        "适用代号",
        "巡检对象类型",
        "类别代号",
        "一级系统",
        "二级部位组",
        "三级关键部件/典型部位",
        "部件介绍描述",
        "四级巡检项-典型巡检项（看什么/查什么）",
        "巡检维度",
        "巡检方式",
        "巡检依据（标准）",
        "参考章节（编号）",
        "推荐巡检频次（建议）",
        "点位等级（1-3，1最高）",
        "巡检执行部门",
        "整改部门",
        "所属区域",
        "确认状态",
    ],
}

ALLOWED_CONFIRMATION_STATES = {
    "confirmed",
    "seeded",
    "assumed",
    "needs_review",
    "sample_only",
}

LEVEL_ORDER = {"L0": 0, "L1": 1, "L2": 2, "L3": 3, "L4": 4}


def normalize_text(value: object) -> str:
    if value is None:
        return ""
    return str(value).replace("\u3000", " ").replace("\n", " ").strip()


def row_dict_to_values(sheet_name: str, row: dict[str, object]) -> list[object]:
    return [row.get(header, "") for header in SHEET_HEADERS[sheet_name]]


def row_values_to_dict(sheet_name: str, values: Iterable[object]) -> dict[str, str]:
    headers = SHEET_HEADERS[sheet_name]
    items = list(values)
    items.extend([""] * (len(headers) - len(items)))
    return {header: normalize_text(items[index]) for index, header in enumerate(headers)}


def blank_sheet_rows(sheet_name: str) -> list[list[object]]:
    return [SHEET_HEADERS[sheet_name]]
