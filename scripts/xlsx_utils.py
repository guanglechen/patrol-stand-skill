from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile
from xml.sax.saxutils import escape


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
DC_NS = "http://purl.org/dc/elements/1.1/"
DCTERMS_NS = "http://purl.org/dc/terms/"
XSI_NS = "http://www.w3.org/2001/XMLSchema-instance"


def _normalize_target(target: str) -> str:
    cleaned = target.lstrip("/")
    if cleaned.startswith("xl/"):
        return cleaned
    return f"xl/{cleaned}"


def _column_letters_to_index(letters: str) -> int:
    value = 0
    for char in letters:
        value = value * 26 + (ord(char.upper()) - 64)
    return value - 1


def _index_to_column_letters(index: int) -> str:
    value = index + 1
    letters: list[str] = []
    while value:
        value, remainder = divmod(value - 1, 26)
        letters.append(chr(65 + remainder))
    return "".join(reversed(letters))


def _cell_ref(row_index: int, column_index: int) -> str:
    return f"{_index_to_column_letters(column_index)}{row_index}"


def _range_ref(row_count: int, column_count: int) -> str:
    if row_count <= 0 or column_count <= 0:
        return "A1:A1"
    return f"A1:{_cell_ref(row_count, column_count - 1)}"


def _shared_strings(zf: ZipFile) -> list[str]:
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    namespace = {"a": MAIN_NS}
    values: list[str] = []
    for item in root.findall("a:si", namespace):
        text = "".join(node.text or "" for node in item.iterfind(".//a:t", namespace))
        values.append(text)
    return values


def _cell_value(cell: ET.Element, shared: list[str]) -> str:
    namespace = {"a": MAIN_NS}
    cell_type = cell.attrib.get("t")
    if cell_type == "s":
        value = cell.find("a:v", namespace)
        return shared[int(value.text)] if value is not None and value.text else ""
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.iterfind(".//a:t", namespace))
    value = cell.find("a:v", namespace)
    if value is not None and value.text is not None:
        return value.text
    formula = cell.find("a:f", namespace)
    return f"={formula.text}" if formula is not None and formula.text else ""


def read_workbook(path: str | Path) -> dict[str, list[list[str]]]:
    workbook_path = Path(path)
    namespace = {"a": MAIN_NS, "pr": PACKAGE_REL_NS}
    result: dict[str, list[list[str]]] = {}
    with ZipFile(workbook_path) as zf:
        shared = _shared_strings(zf)
        workbook_root = ET.fromstring(zf.read("xl/workbook.xml"))
        rel_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        rel_map = {
            rel.attrib["Id"]: _normalize_target(rel.attrib["Target"])
            for rel in rel_root.findall("pr:Relationship", namespace)
        }
        for sheet in workbook_root.find("a:sheets", namespace) or []:
            rel_id = sheet.attrib[f"{{{OFFICE_REL_NS}}}id"]
            sheet_name = sheet.attrib["name"]
            sheet_root = ET.fromstring(zf.read(rel_map[rel_id]))
            rows: list[list[str]] = []
            max_width = 0
            sheet_data = sheet_root.find("a:sheetData", namespace)
            if sheet_data is None:
                result[sheet_name] = rows
                continue
            for row in sheet_data.findall("a:row", namespace):
                values: list[str] = []
                for cell in row.findall("a:c", namespace):
                    ref = cell.attrib.get("r", "")
                    letters = "".join(ch for ch in ref if ch.isalpha())
                    index = _column_letters_to_index(letters) if letters else len(values)
                    while len(values) < index:
                        values.append("")
                    values.append(_cell_value(cell, shared))
                max_width = max(max_width, len(values))
                rows.append(values)
            for row in rows:
                row.extend([""] * (max_width - len(row)))
            result[sheet_name] = rows
    return result


def _inline_string_cell(ref: str, value: str, style: int | None = None) -> str:
    escaped = escape(value)
    style_attr = f' s="{style}"' if style is not None else ""
    return f'<c r="{ref}"{style_attr} t="inlineStr"><is><t>{escaped}</t></is></c>'


def _number_cell(ref: str, value: int | float, style: int | None = None) -> str:
    style_attr = f' s="{style}"' if style is not None else ""
    return f'<c r="{ref}"{style_attr}><v>{value}</v></c>'


def _column_width(header: str) -> float:
    compact = {"层级", "节点代号", "节点类型", "确认状态", "优先级", "状态", "适用代号", "类别代号"}
    narrative = {
        "设计理由",
        "纳入边界",
        "排除边界",
        "覆盖对象",
        "职责边界",
        "缺口说明",
        "问题描述",
        "当前假设",
        "需要用户补充",
        "部件介绍描述",
        "四级巡检项-典型巡检项（看什么/查什么）",
        "说明",
    }
    if header in compact:
        return 14
    if header in narrative:
        return 34
    if len(header) >= 10:
        return 24
    return 18


def _cols_xml(headers: list[object]) -> str:
    nodes = []
    for index, value in enumerate(headers, start=1):
        width = _column_width(str(value))
        nodes.append(f'<col min="{index}" max="{index}" width="{width}" customWidth="1"/>')
    return f"<cols>{''.join(nodes)}</cols>"


def _sheet_xml(rows: Iterable[Iterable[object]]) -> str:
    materialized = [list(row) for row in rows]
    row_chunks: list[str] = []
    for row_index, raw_row in enumerate(materialized, start=1):
        cells: list[str] = []
        for column_index, value in enumerate(raw_row):
            if value is None or value == "":
                continue
            ref = _cell_ref(row_index, column_index)
            style = 1 if row_index == 1 else 2
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                cells.append(_number_cell(ref, value, style))
            else:
                cells.append(_inline_string_cell(ref, str(value), style))
        row_chunks.append(f'<row r="{row_index}">{"".join(cells)}</row>')
    headers = materialized[0] if materialized else []
    filter_ref = _range_ref(max(len(materialized), 1), max(len(headers), 1))
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<worksheet xmlns="{MAIN_NS}">'
        '<sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        '<selection pane="bottomLeft"/>'
        '</sheetView></sheetViews>'
        f"{_cols_xml(headers)}"
        f"<sheetData>{''.join(row_chunks)}</sheetData>"
        f'<autoFilter ref="{filter_ref}"/>'
        "</worksheet>"
    )


def _workbook_xml(sheet_names: list[str]) -> str:
    sheet_nodes = []
    for index, sheet_name in enumerate(sheet_names, start=1):
        escaped = escape(sheet_name)
        sheet_nodes.append(
            f'<sheet name="{escaped}" sheetId="{index}" r:id="rId{index}"/>'
        )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<workbook xmlns="{MAIN_NS}" xmlns:r="{OFFICE_REL_NS}">'
        f"<sheets>{''.join(sheet_nodes)}</sheets>"
        "</workbook>"
    )


def _workbook_rels_xml(sheet_count: int) -> str:
    nodes = []
    for index in range(1, sheet_count + 1):
        nodes.append(
            f'<Relationship Id="rId{index}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            f'Target="worksheets/sheet{index}.xml"/>'
        )
    nodes.append(
        '<Relationship Id="rIdStyles" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
        'Target="styles.xml"/>'
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Relationships xmlns="{PACKAGE_REL_NS}">'
        f"{''.join(nodes)}"
        "</Relationships>"
    )


def _root_rels_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Relationships xmlns="{PACKAGE_REL_NS}">'
        '<Relationship Id="rIdWorkbook" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/>'
        '<Relationship Id="rIdCore" '
        'Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" '
        'Target="docProps/core.xml"/>'
        '<Relationship Id="rIdApp" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" '
        'Target="docProps/app.xml"/>'
        "</Relationships>"
    )


def _content_types_xml(sheet_count: int) -> str:
    overrides = [
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/styles.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
        '<Override PartName="/docProps/core.xml" '
        'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
        '<Override PartName="/docProps/app.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    ]
    for index in range(1, sheet_count + 1):
        overrides.append(
            f'<Override PartName="/xl/worksheets/sheet{index}.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Types xmlns="{CONTENT_TYPES_NS}">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        f"{''.join(overrides)}"
        "</Types>"
    )


def _styles_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<styleSheet xmlns="{MAIN_NS}">'
        '<fonts count="2">'
        '<font><sz val="11"/><name val="Calibri"/></font>'
        '<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>'
        '</fonts>'
        '<fills count="3">'
        '<fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FF263C33"/><bgColor indexed="64"/></patternFill></fill>'
        '</fills>'
        '<borders count="1"><border/></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="3">'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>'
        '</cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        "</styleSheet>"
    )


def _core_xml() -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        f'xmlns:dc="{DC_NS}" xmlns:dcterms="{DCTERMS_NS}" xmlns:xsi="{XSI_NS}">'
        "<dc:title>Inspection Standard Workbook</dc:title>"
        "<dc:creator>Codex</dc:creator>"
        f'<dcterms:created xsi:type="dcterms:W3CDTF">{timestamp}</dcterms:created>'
        f'<dcterms:modified xsi:type="dcterms:W3CDTF">{timestamp}</dcterms:modified>'
        "</cp:coreProperties>"
    )


def _app_xml(sheet_names: list[str]) -> str:
    titles = "".join(f"<vt:lpstr>{escape(name)}</vt:lpstr>" for name in sheet_names)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        "<Application>Codex</Application>"
        f"<TitlesOfParts><vt:vector size=\"{len(sheet_names)}\" baseType=\"lpstr\">{titles}</vt:vector></TitlesOfParts>"
        "</Properties>"
    )


def write_workbook(path: str | Path, sheets: list[tuple[str, list[list[object]]]]) -> None:
    workbook_path = Path(path)
    workbook_path.parent.mkdir(parents=True, exist_ok=True)
    sheet_names = [name for name, _ in sheets]
    with ZipFile(workbook_path, "w", compression=ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", _content_types_xml(len(sheets)))
        zf.writestr("_rels/.rels", _root_rels_xml())
        zf.writestr("xl/workbook.xml", _workbook_xml(sheet_names))
        zf.writestr("xl/_rels/workbook.xml.rels", _workbook_rels_xml(len(sheets)))
        zf.writestr("xl/styles.xml", _styles_xml())
        zf.writestr("docProps/core.xml", _core_xml())
        zf.writestr("docProps/app.xml", _app_xml(sheet_names))
        for index, (_, rows) in enumerate(sheets, start=1):
            zf.writestr(f"xl/worksheets/sheet{index}.xml", _sheet_xml(rows))
