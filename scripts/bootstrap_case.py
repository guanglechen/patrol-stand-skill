#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Iterable

from contract import SHEET_HEADERS, normalize_text
from xlsx_utils import read_workbook


INDUSTRIAL_L1_DEFAULTS = {
    "工程设备": {
        "code": "L1-ENG",
        "reason": "将园区机电、公辅和设备房类系统聚合，便于工程运维统一设计标准层级。",
        "include": "建筑机电、公辅、给排水、暖通、电梯及设备房相关对象。",
        "exclude": "纯弱电信号系统、智能控制平台、公区环境和消防治理主责内容。",
        "owner": "工程运维负责人",
    },
    "电力与弱电": {
        "code": "L1-POWER",
        "reason": "将供配电与弱电子系统并列治理，便于处理供电连续性与线路接口。",
        "include": "高低压配电、备用电源、防雷接地、弱电基础设施。",
        "exclude": "以业务逻辑或平台联动为主的智能化控制域。",
        "owner": "电力弱电负责人",
    },
    "智能化与仪控": {
        "code": "L1-AUTO",
        "reason": "将依赖感知、联动、控制和数字平台的数据域单独建类，避免被传统弱电吞没。",
        "include": "监控、门禁、道闸、楼控、自控、网络通信等系统。",
        "exclude": "纯配电线路、公区卫生与消防实体设施主责内容。",
        "owner": "智能化负责人",
    },
    "环境与消防": {
        "code": "L1-EHS",
        "reason": "将公区环境、秩序安保和消防治理合并为安全与环境治理域，便于形成风险闭环。",
        "include": "消防设施、安全巡视、环境卫生、绿化维护、公区秩序等对象。",
        "exclude": "机电本体和平台控制逻辑主责内容。",
        "owner": "安环/消防负责人",
    },
}

ROLE_TEMPLATES = [
    {
        "部门/角色": "项目负责人",
        "职责边界": "冻结架构树版本、协调跨专业边界、批准分类调整。",
        "对应一级分类": "全部",
        "对应二级类别": "",
        "巡检责任": "统筹",
        "整改责任": "统筹升级",
        "审核责任": "最终审批",
        "来源": "industry_pack_default",
    },
    {
        "部门/角色": "第三方维保接口人",
        "职责边界": "管理外包设施、证据移交和第三方整改接口。",
        "对应一级分类": "全部",
        "对应二级类别": "",
        "巡检责任": "协同",
        "整改责任": "接口跟踪",
        "审核责任": "资料归档核查",
        "来源": "industry_pack_default",
    },
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="从巡检材料工作簿生成层级优先的 case JSON。")
    parser.add_argument("--workbook", required=True, help="源工作簿路径")
    parser.add_argument("--output", required=True, help="输出 JSON 路径")
    parser.add_argument("--industry", default="auto", help="行业提示，例如 auto、industrial_park、chemical")
    parser.add_argument("--project-name", default="", help="可选的项目名称覆盖值")
    parser.add_argument("--scope", default="", help="可选的范围说明")
    parser.add_argument("--existing-system", default="", help="可选的现有系统说明")
    parser.add_argument("--sample-limit", type=int, default=40, help="最多输出多少条标准清单样例行")
    return parser.parse_args()


def detect_industry(workbook_path: Path, sheet_names: Iterable[str], hint: str) -> str:
    if hint and hint != "auto":
        return hint
    joined = " ".join(sheet_names) + " " + workbook_path.as_posix()
    if "产业园" in joined:
        return "industrial_park"
    if "静设备" in joined or "化工" in joined:
        return "chemical"
    return "generic"


def source_kind(sheet_names: set[str]) -> str:
    if "标准清单" in sheet_names:
        return "standard_workbook"
    if "产业园巡检总览" in sheet_names:
        return "raw_hierarchy_workbook"
    return "generic_workbook"


def _pad_row(row: list[str], width: int) -> list[str]:
    padded = list(row)
    padded.extend([""] * (width - len(padded)))
    return padded


def _fill_down_rows(rows: list[list[str]], carry_columns: int) -> list[list[str]]:
    carry = [""] * carry_columns
    result: list[list[str]] = []
    for row in rows:
        padded = list(row)
        for index in range(min(carry_columns, len(padded))):
            value = normalize_text(padded[index])
            if value:
                carry[index] = value
            else:
                padded[index] = carry[index]
        result.append(padded)
    return result


def classify_industrial_park_l1(*parts: str) -> str:
    joined = " ".join(normalize_text(part) for part in parts)
    if any(token in joined for token in ("配电", "电力", "弱电", "照明", "UPS", "防雷", "接地", "备用电源")):
        return "电力与弱电"
    if any(token in joined for token in ("监控", "门禁", "道闸", "楼控", "自控", "网络", "通信", "停车场", "智能", "BA", "BMS")):
        return "智能化与仪控"
    if any(token in joined for token in ("消防", "安保", "巡视", "卫生", "清洁", "绿化", "环境", "公区")):
        return "环境与消防"
    return "工程设备"


def build_role_rows(l1_names: list[str]) -> list[dict[str, str]]:
    rows = [dict(template) for template in ROLE_TEMPLATES]
    for name in l1_names:
        owner = INDUSTRIAL_L1_DEFAULTS.get(name, {}).get("owner", "待确认负责人")
        rows.append(
            {
                "部门/角色": owner,
                "职责边界": f"负责{name}的分类冻结、巡检执行边界和整改闭环归口。",
                "对应一级分类": name,
                "对应二级类别": "",
                "巡检责任": f"{name}日常执行归口",
                "整改责任": f"{name}问题整改归口",
                "审核责任": f"{name}分类与标准复核",
                "来源": "seeded_from_industry_pack",
            }
        )
    return rows


def build_clarifications(industry: str, observed_l2: list[str]) -> list[dict[str, str]]:
    items = [
        {
            "问题类型": "组织边界",
            "问题描述": "确认各一级分类的实际归口部门，避免默认角色与项目组织不一致。",
            "影响层级": "L1/L2",
            "当前假设": "先按行业包默认角色分配。",
            "需要用户补充": "项目组织架构、部门职责、外包边界。",
            "优先级": "high",
            "状态": "open",
        },
        {
            "问题类型": "租户与第三方",
            "问题描述": "确认租户设施、第三方维保设施是否纳入主架构还是只写边界说明。",
            "影响层级": "L1/L2",
            "当前假设": "先纳入边界说明，不直接扩成独立L1。",
            "需要用户补充": "租户责任划分和外包运维清单。",
            "优先级": "high",
            "状态": "open",
        },
        {
            "问题类型": "高风险场景",
            "问题描述": "确认是否存在必须单列的高风险场景或法定重点对象。",
            "影响层级": "L2/L3",
            "当前假设": "先沿用通用分类，不额外新建高风险一级层。",
            "需要用户补充": "高风险区域、重点设施、事故复盘材料。",
            "优先级": "medium",
            "状态": "open",
        },
    ]
    if industry == "industrial_park" and "电梯系统" in observed_l2:
        items.append(
            {
                "问题类型": "特种设施拆分",
                "问题描述": "确认电梯系统继续放在工程设备下，还是需要作为独立二级类别强化治理。",
                "影响层级": "L2",
                "当前假设": "先保留在工程设备域内。",
                "需要用户补充": "特种设备台账、维保合同、监管要求。",
                "优先级": "medium",
                "状态": "open",
            }
        )
    return items


def build_reference_rows(rows: list[list[str]], source_note: str) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for raw in rows[1:]:
        values = [normalize_text(value) for value in raw if normalize_text(value)]
        if not values:
            continue
        url = next((value for value in values if value.startswith("http")), "")
        text_candidates = [
            value
            for value in values
            if not value.startswith("http") and not value.isdigit() and not value.startswith("=")
        ]
        name = text_candidates[0] if text_candidates else ""
        if not name:
            continue
        result.append(
            {
                "标准编号": "",
                "标准名称": name,
                "关联系统": "通用",
                "关联系统/对象": "全部",
                "来源URL": url,
                "说明": source_note,
            }
        )
    return result


def _hierarchy_row(
    level: str,
    parent: str,
    name: str,
    code: str,
    node_type: str,
    covered: str,
    reason: str,
    include: str,
    exclude: str,
    owner: str,
    references: str,
    state: str,
) -> dict[str, str]:
    return {
        "层级": level,
        "父节点": parent,
        "节点名称": name,
        "节点代号": code,
        "节点类型": node_type,
        "覆盖对象": covered,
        "设计理由": reason,
        "纳入边界": include,
        "排除边界": exclude,
        "责任专业": owner,
        "参考依据": references,
        "确认状态": state,
    }


def build_case_from_raw_industrial(
    workbook_path: Path,
    sheets: dict[str, list[list[str]]],
    project_name: str,
    sample_limit: int,
) -> dict[str, object]:
    raw_rows = sheets["产业园巡检总览"]
    data_rows = [_pad_row(row, 12)[:12] for row in raw_rows[3:] if any(normalize_text(cell) for cell in row)]
    data_rows = _fill_down_rows(data_rows, 6)
    observations = []
    for row in data_rows:
        specialty, level1, level2, level3, level4 = row[1], row[2], row[3], row[4], row[5]
        observations.append(
            {
                "specialty": specialty,
                "level1": level1,
                "level2": level2,
                "level3": level3,
                "level4": level4,
                "check_method": row[6],
                "merge_reason": row[7],
                "reference_standard": row[8],
                "reference_clause": row[9],
                "frequency": row[10],
                "inspection_method": row[11],
                "mapped_l1": classify_industrial_park_l1(specialty, level1, level2, level3),
            }
        )

    hierarchy_rows: list[dict[str, str]] = [
        _hierarchy_row(
            "L0",
            "",
            "industrial_park",
            "L0-INDUSTRIAL_PARK",
            "行业/场景包",
            "产业园共性设施、空间和运行场景",
            "以产业园行业包作为首版成熟场景，优先冻结分类治理逻辑。",
            "纳入产业园机电、公区、安防、环境与消防类对象。",
            "暂不纳入其他行业的专有生产设备分类逻辑。",
            "项目负责人",
            "industrial_park pack; 用户原始业务梳理表",
            "seeded",
        )
    ]

    observed_by_l1: dict[str, set[str]] = defaultdict(set)
    observed_l2_names: dict[tuple[str, str], set[str]] = defaultdict(set)
    observed_l3_names: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    coverage_seeds: list[dict[str, str]] = []

    for obs in observations:
        mapped_l1 = obs["mapped_l1"]
        observed_by_l1[mapped_l1].add(obs["level1"] or obs["level2"] or obs["level3"])
        l2_name = obs["level1"] or obs["specialty"] or "待确认二级类别"
        l3_name = obs["level3"] or obs["level2"] or "待确认对象"
        observed_l2_names[(mapped_l1, l2_name)].add(obs["level2"] or obs["level3"] or obs["level4"])
        observed_l3_names[(mapped_l1, l2_name, l3_name)].add(obs["level4"])
        coverage_seeds.append(
            {
                "业务域": obs["specialty"] or "待确认专业",
                "专业": obs["specialty"] or "待确认专业",
                "对象域": " / ".join(part for part in [obs["level2"], obs["level3"]] if part),
                "风险场景": "待结合项目高风险场景确认",
                "对应L1": mapped_l1,
                "对应L2": l2_name,
                "覆盖状态": "observed",
                "缺口说明": "",
            }
        )

    l1_names = [name for name in INDUSTRIAL_L1_DEFAULTS if observed_by_l1.get(name)]
    for name in l1_names:
        definition = INDUSTRIAL_L1_DEFAULTS[name]
        covered = "；".join(sorted(item for item in observed_by_l1[name] if item)[:6])
        hierarchy_rows.append(
            _hierarchy_row(
                "L1",
                "industrial_park",
                name,
                definition["code"],
                "一级分类",
                covered,
                definition["reason"],
                definition["include"],
                definition["exclude"],
                definition["owner"],
                f"{workbook_path.name} / 产业园巡检总览",
                "seeded",
            )
        )

    l2_counters: dict[str, int] = defaultdict(int)
    l2_node_names: dict[tuple[str, str], str] = {}
    l3_counters: dict[str, int] = defaultdict(int)
    for l1_name in l1_names:
        l2_keys = sorted(key for key in observed_l2_names if key[0] == l1_name)
        for _, l2_name in l2_keys:
            l2_counters[l1_name] += 1
            l2_node_name = f"{l1_name} / {l2_name}"
            l2_node_names[(l1_name, l2_name)] = l2_node_name
            covered = "；".join(sorted(item for item in observed_l2_names[(l1_name, l2_name)] if item)[:6])
            hierarchy_rows.append(
                _hierarchy_row(
                    "L2",
                    l1_name,
                    l2_node_name,
                    f"{INDUSTRIAL_L1_DEFAULTS[l1_name]['code']}-L2-{l2_counters[l1_name]:02d}",
                    "二级类别",
                    covered,
                    f"依据用户材料中观测到的系统/场景「{l2_name}」归并为{l1_name}下的稳定类别。",
                    f"纳入当前材料中归属于「{l2_name}」的对象、空间和典型问题。",
                    "暂不纳入未在当前材料中出现、但应由其他一级分类负责的对象。",
                    INDUSTRIAL_L1_DEFAULTS[l1_name]["owner"],
                    f"{workbook_path.name} / 产业园巡检总览",
                    "seeded",
                )
            )
            l3_keys = sorted(key for key in observed_l3_names if key[0] == l1_name and key[1] == l2_name)
            for _, _, l3_name in l3_keys:
                l3_counters[l2_name] += 1
                covered_items = "；".join(sorted(item for item in observed_l3_names[(l1_name, l2_name, l3_name)] if item)[:4])
                l3_node_name = f"{l2_node_name} / {l3_name}"
                hierarchy_rows.append(
                    _hierarchy_row(
                        "L3",
                        l2_node_name,
                        l3_node_name,
                        f"{INDUSTRIAL_L1_DEFAULTS[l1_name]['code']}-L3-{l3_counters[l2_name]:02d}",
                        "典型对象/部位组",
                        covered_items or l3_name,
                        f"以用户材料中反复出现的对象/部位「{l3_name}」作为{l2_name}的代表对象。",
                        f"纳入材料中与「{l3_name}」直接相关的对象和样例巡检关注点。",
                        "暂不展开为全面巡检项列表。",
                        INDUSTRIAL_L1_DEFAULTS[l1_name]["owner"],
                        f"{workbook_path.name} / 产业园巡检总览",
                        "seeded",
                    )
                )

    coverage_rows: list[dict[str, str]] = []
    for row in coverage_seeds:
        mapped_l2 = l2_node_names.get((row["对应L1"], row["对应L2"]), row["对应L2"])
        coverage_rows.append({**row, "对应L2": mapped_l2})

    reference_rows = build_reference_rows(
        sheets.get("相关法律法规", []),
        "来自原始产业园法规清单，尚需按分类树进一步挂接。",
    )

    role_rows = build_role_rows(l1_names)
    clarification_rows = build_clarifications(
        "industrial_park",
        [key[1] for key in observed_l2_names],
    )

    l1_to_owner = {name: INDUSTRIAL_L1_DEFAULTS[name]["owner"] for name in INDUSTRIAL_L1_DEFAULTS}
    l1_to_rectify = {
        "工程设备": "工程运维负责人",
        "电力与弱电": "电力弱电负责人",
        "智能化与仪控": "智能化负责人",
        "环境与消防": "安环/消防负责人",
    }
    sample_rows: list[dict[str, str]] = []
    for obs in observations[:sample_limit]:
        sample_rows.append(
            {
                "一级分类": obs["mapped_l1"],
                "系统属性": "raw_hierarchy_seed",
                "适用设备类别": obs["level3"],
                "适用代号": "",
                "巡检对象类型": obs["level3"] or obs["level2"],
                "类别代号": "",
                "一级系统": obs["level1"],
                "二级部位组": obs["level2"],
                "三级关键部件/典型部位": obs["level3"],
                "部件介绍描述": "",
                "四级巡检项-典型巡检项（看什么/查什么）": obs["level4"],
                "巡检维度": obs["check_method"],
                "巡检方式": obs["inspection_method"],
                "巡检依据（标准）": obs["reference_standard"],
                "参考章节（编号）": obs["reference_clause"],
                "推荐巡检频次（建议）": obs["frequency"],
                "点位等级（1-3，1最高）": "",
                "巡检执行部门": l1_to_owner.get(obs["mapped_l1"], ""),
                "整改部门": l1_to_rectify.get(obs["mapped_l1"], ""),
                "所属区域": obs["level2"] or obs["level1"],
                "确认状态": "sample_only",
            }
        )

    return {
        "metadata": {
            "industry": "industrial_park",
            "source_kind": "raw_hierarchy_workbook",
            "source_workbook": str(workbook_path),
        },
        "case_intake": {
            "project_name": project_name,
            "industry_hint": "industrial_park",
            "material_paths": [str(workbook_path)],
            "scope": "",
            "existing_system": "",
        },
        "hierarchy_rows": hierarchy_rows,
        "organization_rows": role_rows,
        "coverage_rows": coverage_rows,
        "clarification_rows": clarification_rows,
        "reference_rows": reference_rows,
        "standard_rows": sample_rows,
    }


def build_case_from_standard_workbook(
    workbook_path: Path,
    sheets: dict[str, list[list[str]]],
    project_name: str,
    industry: str,
) -> dict[str, object]:
    standard_rows_raw = sheets.get("标准清单", [])
    reference_rows_raw = sheets.get("引申依据", [])
    hierarchy_tree_raw = sheets.get("巡检标准架构树", [])

    standard_headers = [_pad_row(standard_rows_raw[0], len(SHEET_HEADERS["标准清单"]) - 1)]
    parsed_standard_rows = []
    if standard_rows_raw:
        base_headers = standard_headers[0]
        for row in standard_rows_raw[1:]:
            padded = _pad_row(row, len(base_headers))
            row_dict = {base_headers[index]: normalize_text(padded[index]) for index in range(len(base_headers))}
            if not row_dict.get("一级分类"):
                continue
            row_dict["确认状态"] = "seeded"
            parsed_standard_rows.append(row_dict)

    hierarchy_rows: list[dict[str, str]] = []
    if hierarchy_tree_raw and len(hierarchy_tree_raw) >= 4:
        hierarchy_rows.append(
            _hierarchy_row(
                "L0",
                "",
                industry,
                f"L0-{industry.upper()}",
                "行业/场景包",
                f"{industry}历史标准工作簿",
                "复用历史标准架构树作为首版层级设计起点。",
                "纳入现有工作簿已显式定义的分类体系。",
                "不自动扩展超出历史工作簿之外的新一级分类。",
                "项目负责人",
                f"{workbook_path.name} / 巡检标准架构树",
                "seeded",
            )
        )
        l1_seen: set[str] = set()
        l2_counter: defaultdict[str, int] = defaultdict(int)
        l3_counter: defaultdict[str, int] = defaultdict(int)
        grouped_l2: dict[tuple[str, str], dict[str, object]] = {}
        skip_l1_names = {"一级专业", "一级分类", "层级", "节点名称"}
        skip_l2_names = {"二级类别", "节点名称", "分类名称"}
        for row in hierarchy_tree_raw[3:]:
            padded = _pad_row(row, 7)
            l1_name = normalize_text(padded[0])
            l1_reason = normalize_text(padded[1])
            l2_name = normalize_text(padded[2])
            l2_code = normalize_text(padded[3]) or "UNK"
            l3_group = normalize_text(padded[4])
            l2_reason = normalize_text(padded[5])
            l2_reference = normalize_text(padded[6])
            if (
                not l1_name
                or not l2_name
                or (l1_name in skip_l1_names and l2_name in skip_l2_names)
            ):
                continue
            parts = [
                item.strip()
                for item in l3_group.replace("；", ";").split(";")
                if item.strip()
            ]
            key = (l1_name, l2_name)
            if key not in grouped_l2:
                grouped_l2[key] = {
                    "l1_reason": l1_reason,
                    "l2_code": l2_code,
                    "l2_reason": l2_reason,
                    "l2_reference": l2_reference,
                    "parts": [],
                }
            group = grouped_l2[key]
            if l1_reason and not group["l1_reason"]:
                group["l1_reason"] = l1_reason
            if l2_reason and not group["l2_reason"]:
                group["l2_reason"] = l2_reason
            if l2_reference and not group["l2_reference"]:
                group["l2_reference"] = l2_reference
            if l2_code and group["l2_code"] == "UNK":
                group["l2_code"] = l2_code
            for part in parts:
                if part not in group["parts"]:
                    group["parts"].append(part)

        for l1_name, l2_name in sorted(grouped_l2):
            group = grouped_l2[(l1_name, l2_name)]
            if l1_name not in l1_seen:
                hierarchy_rows.append(
                    _hierarchy_row(
                        "L1",
                        industry,
                        l1_name,
                        f"L1-{len(l1_seen) + 1:02d}",
                        "一级分类",
                        l2_name,
                        str(group["l1_reason"]) or f"沿用历史工作簿中的一级分类「{l1_name}」。",
                        f"纳入历史工作簿中归属于「{l1_name}」的分类对象。",
                        "暂不纳入未在历史工作簿中出现的新一级分类。",
                        "待确认专业负责人",
                        f"{workbook_path.name} / 巡检标准架构树",
                        "seeded",
                    )
                )
                l1_seen.add(l1_name)
            l2_counter[l1_name] += 1
            l2_node_name = f"{l1_name} / {l2_name}"
            hierarchy_rows.append(
                _hierarchy_row(
                    "L2",
                    l1_name,
                    l2_node_name,
                    f"L2-{group['l2_code']}-{l2_counter[l1_name]:02d}",
                    "二级类别",
                    "；".join(group["parts"]) if group["parts"] else l2_name,
                    str(group["l2_reason"]) or f"沿用历史工作簿中的二级类别「{l2_name}」。",
                    f"纳入历史工作簿中列在「{l2_name}」之下的典型对象。",
                    "暂不自动扩展为新的对象族。",
                    "待确认专业负责人",
                    str(group["l2_reference"]) or f"{workbook_path.name} / 巡检标准架构树",
                    "seeded",
                )
            )
            for part in group["parts"]:
                l3_counter[l2_name] += 1
                l3_node_name = f"{l2_node_name} / {part}"
                hierarchy_rows.append(
                    _hierarchy_row(
                        "L3",
                        l2_node_name,
                        l3_node_name,
                        f"L3-{group['l2_code']}-{l3_counter[l2_name]:02d}",
                        "典型对象/部位组",
                        part,
                        f"将历史工作簿中的代表对象「{part}」保留为{l2_name}的典型对象。",
                        f"纳入历史架构树明确列示的对象「{part}」。",
                        "暂不自动生成新的部位组。",
                        "待确认专业负责人",
                        str(group["l2_reference"]) or f"{workbook_path.name} / 巡检标准架构树",
                        "seeded",
                    )
                )

    if not hierarchy_rows and parsed_standard_rows:
        hierarchy_rows.append(
            _hierarchy_row(
                "L0",
                "",
                industry,
                f"L0-{industry.upper()}",
                "行业/场景包",
                f"{industry}标准工作簿",
                "缺少显式架构树时，依据标准清单反推层级结构作为审阅起点。",
                "纳入标准清单中已经出现的一级分类与对象族。",
                "不自动扩展超出标准清单的分类。",
                "项目负责人",
                f"{workbook_path.name} / 标准清单",
                "seeded",
            )
        )
        l1_seen: set[str] = set()
        l2_counter: defaultdict[str, int] = defaultdict(int)
        l3_counter: defaultdict[str, int] = defaultdict(int)
        for row in parsed_standard_rows:
            l1_name = row.get("一级分类", "") or "待确认一级分类"
            l2_name = row.get("适用设备类别", "") or row.get("一级系统", "") or "待确认二级类别"
            l3_name = row.get("三级关键部件/典型部位", "") or row.get("巡检对象类型", "") or "待确认对象"
            l2_node_name = f"{l1_name} / {l2_name}"
            if l1_name not in l1_seen:
                hierarchy_rows.append(
                    _hierarchy_row(
                        "L1",
                        industry,
                        l1_name,
                        f"L1-{len(l1_seen) + 1:02d}",
                        "一级分类",
                        l2_name,
                        f"依据标准清单中反复出现的一级分类「{l1_name}」反推一级结构。",
                        f"纳入标准清单中归属于「{l1_name}」的对象。",
                        "暂不纳入未出现在标准清单中的新一级分类。",
                        "待确认专业负责人",
                        f"{workbook_path.name} / 标准清单",
                        "seeded",
                    )
                )
                l1_seen.add(l1_name)
            l2_counter[l1_name] += 1
            if not any(existing["节点名称"] == l2_node_name and existing["父节点"] == l1_name for existing in hierarchy_rows):
                hierarchy_rows.append(
                    _hierarchy_row(
                        "L2",
                        l1_name,
                        l2_node_name,
                        f"L2-{l1_name}-{l2_counter[l1_name]:02d}",
                        "二级类别",
                        l3_name,
                        f"依据标准清单中的对象族「{l2_name}」反推二级类别。",
                        f"纳入标准清单中归属于「{l2_name}」的对象。",
                        "暂不扩展为新的对象族。",
                        "待确认专业负责人",
                        f"{workbook_path.name} / 标准清单",
                        "seeded",
                    )
                )
            l3_node_name = f"{l2_node_name} / {l3_name}"
            l3_counter[l2_name] += 1
            if not any(existing["节点名称"] == l3_node_name and existing["父节点"] == l2_node_name for existing in hierarchy_rows):
                hierarchy_rows.append(
                    _hierarchy_row(
                        "L3",
                        l2_node_name,
                        l3_node_name,
                        f"L3-{l2_name}-{l3_counter[l2_name]:02d}",
                        "典型对象/部位组",
                        l3_name,
                        f"依据标准清单中的对象「{l3_name}」反推典型对象层。",
                        f"纳入标准清单中出现的「{l3_name}」。",
                        "暂不自动扩展为新的对象组。",
                        "待确认专业负责人",
                        f"{workbook_path.name} / 标准清单",
                        "seeded",
                    )
                )

    l1_names = [row["节点名称"] for row in hierarchy_rows if row["层级"] == "L1"]
    role_rows = build_role_rows(l1_names or ["待确认一级分类"])
    coverage_rows = []
    for row in parsed_standard_rows:
        l2_name = row.get("适用设备类别", "") or row.get("一级系统", "")
        coverage_rows.append(
            {
                "业务域": row.get("一级分类", ""),
                "专业": row.get("一级分类", ""),
                "对象域": row.get("适用设备类别", "") or row.get("巡检对象类型", ""),
                "风险场景": "待结合历史事件和法规确认",
                "对应L1": row.get("一级分类", ""),
                "对应L2": f"{row.get('一级分类', '')} / {l2_name}" if l2_name else "",
                "覆盖状态": "observed",
                "缺口说明": "",
            }
        )
    clarification_rows = [
        {
            "问题类型": "历史延续",
            "问题描述": "确认本次是否严格继承历史一级分类，还是允许重构。",
            "影响层级": "L1/L2",
            "当前假设": "先延续历史结构。",
            "需要用户补充": "是否允许重构旧分类的决策口径。",
            "优先级": "high",
            "状态": "open",
        },
        {
            "问题类型": "组织归口",
            "问题描述": "旧工作簿未显式提供完整组织归口，需要补齐职责映射。",
            "影响层级": "L1/L2",
            "当前假设": "先使用默认角色占位。",
            "需要用户补充": "项目组织职责或归口清单。",
            "优先级": "high",
            "状态": "open",
        },
    ]
    reference_rows = []
    if reference_rows_raw:
        headers = _pad_row(reference_rows_raw[0], 6)
        for row in reference_rows_raw[1:]:
            padded = _pad_row(row, len(headers))
            row_dict = {headers[index]: normalize_text(padded[index]) for index in range(len(headers))}
            if not row_dict.get("标准编号") and not row_dict.get("标准名称"):
                continue
            reference_rows.append(row_dict)

    return {
        "metadata": {
            "industry": industry,
            "source_kind": "standard_workbook",
            "source_workbook": str(workbook_path),
        },
        "case_intake": {
            "project_name": project_name,
            "industry_hint": industry,
            "material_paths": [str(workbook_path)],
            "scope": "",
            "existing_system": "",
        },
        "hierarchy_rows": hierarchy_rows,
        "organization_rows": role_rows,
        "coverage_rows": coverage_rows,
        "clarification_rows": clarification_rows,
        "reference_rows": reference_rows,
        "standard_rows": parsed_standard_rows,
    }


def main() -> int:
    args = parse_args()
    workbook_path = Path(args.workbook).expanduser().resolve()
    sheets = read_workbook(workbook_path)
    industry = detect_industry(workbook_path, sheets.keys(), args.industry)
    kind = source_kind(set(sheets))
    project_name = args.project_name or workbook_path.stem

    if kind == "raw_hierarchy_workbook" and industry == "industrial_park":
        payload = build_case_from_raw_industrial(
            workbook_path=workbook_path,
            sheets=sheets,
            project_name=project_name,
            sample_limit=args.sample_limit,
        )
    elif kind == "standard_workbook":
        payload = build_case_from_standard_workbook(
            workbook_path=workbook_path,
            sheets=sheets,
            project_name=project_name,
            industry=industry,
        )
    else:
        raise SystemExit(f"当前工作簿形态暂不支持引导生成 case：{kind} / {industry}")

    payload["case_intake"]["scope"] = args.scope
    payload["case_intake"]["existing_system"] = args.existing_system
    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已写入 case JSON：{output_path}")
    print(
        "摘要：",
        json.dumps(
            {
                "industry": payload["metadata"]["industry"],
                "source_kind": payload["metadata"]["source_kind"],
                "hierarchy_rows": len(payload["hierarchy_rows"]),
                "organization_rows": len(payload["organization_rows"]),
                "coverage_rows": len(payload["coverage_rows"]),
                "clarification_rows": len(payload["clarification_rows"]),
                "reference_rows": len(payload["reference_rows"]),
                "standard_rows": len(payload["standard_rows"]),
            },
            ensure_ascii=False,
        ),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
