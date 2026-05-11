#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile


WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract local patrol task materials into a source digest JSON.")
    parser.add_argument("--manifest", required=True, help="Portable task manifest JSON path")
    parser.add_argument("--output", required=True, help="Digest JSON output path")
    return parser.parse_args()


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def read_text(path: Path) -> str:
    data = path.read_bytes()
    for encoding in ("utf-8", "utf-8-sig", "gb18030", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def extract_docx(path: Path) -> str:
    with ZipFile(path) as zf:
        root = ET.fromstring(zf.read("word/document.xml"))
    ns = {"w": WORD_NS}
    paragraphs = []
    for para in root.findall(".//w:p", ns):
        text = "".join(node.text or "" for node in para.findall(".//w:t", ns))
        if clean_text(text):
            paragraphs.append(clean_text(text))
    return "\n".join(paragraphs)


def shared_strings(zf: ZipFile) -> list[str]:
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    ns = {"a": SHEET_NS}
    values = []
    for item in root.findall("a:si", ns):
        values.append("".join(node.text or "" for node in item.findall(".//a:t", ns)))
    return values


def extract_xlsx(path: Path) -> str:
    rows = []
    ns = {"a": SHEET_NS, "r": PKG_REL_NS}
    with ZipFile(path) as zf:
        shared = shared_strings(zf)
        workbook = ET.fromstring(zf.read("xl/workbook.xml"))
        rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        rel_map = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels.findall("r:Relationship", ns)}
        for sheet in workbook.findall(".//a:sheet", ns):
            sheet_name = sheet.attrib.get("name", "Sheet")
            rel_id = sheet.attrib[f"{{{REL_NS}}}id"]
            target = rel_map[rel_id]
            sheet_path = "xl/" + target.lstrip("/")
            root = ET.fromstring(zf.read(sheet_path))
            preview_rows = []
            for row in root.findall(".//a:row", ns)[:12]:
                cells = []
                for cell in row.findall("a:c", ns)[:12]:
                    value = cell.find("a:v", ns)
                    if value is None or value.text is None:
                        cells.append("")
                    elif cell.attrib.get("t") == "s":
                        cells.append(shared[int(value.text)] if value.text.isdigit() and int(value.text) < len(shared) else "")
                    else:
                        cells.append(value.text)
                if any(clean_text(cell) for cell in cells):
                    preview_rows.append(" | ".join(clean_text(cell) for cell in cells))
            if preview_rows:
                rows.append(f"[{sheet_name}]\n" + "\n".join(preview_rows))
    return "\n\n".join(rows)


def extract_csv(path: Path) -> str:
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        reader = csv.reader(handle)
        return "\n".join(" | ".join(row[:12]) for _, row in zip(range(20), reader))


def extract_file(path: Path) -> tuple[str, str]:
    suffix = path.suffix.lower()
    try:
        if suffix in {".txt", ".md", ".markdown", ".json", ".yaml", ".yml"}:
            text = read_text(path)
            return "text", text
        if suffix == ".csv":
            return "csv", extract_csv(path)
        if suffix == ".docx":
            return "docx", extract_docx(path)
        if suffix == ".xlsx":
            return "xlsx", extract_xlsx(path)
        if suffix == ".pdf":
            return "pdf", "PDF text extraction is not available in the lightweight local extractor; mark content needs_review."
        return "unsupported", "Unsupported attachment type; ask user for a text or Excel/Word version if needed."
    except Exception as exc:  # noqa: BLE001
        return "error", f"Extraction failed: {exc}"


def signals_from_text(text: str) -> dict[str, list[str]]:
    keywords = {
        "responsibility": ["责任", "部门", "角色", "外包", "租户", "第三方", "整改", "审核"],
        "objects": ["设备", "设施", "系统", "部件", "点位", "区域", "配电", "消防", "安防"],
        "standards": ["标准", "依据", "频次", "风险", "异常", "闭环", "留痕"],
    }
    result = {}
    for key, words in keywords.items():
        result[key] = [word for word in words if word in text]
    return result


def main() -> int:
    args = parse_args()
    manifest_path = Path(args.manifest).resolve()
    output_path = Path(args.output).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    materials = []
    combined = []

    for message in manifest.get("messages", []):
        if message.get("role") == "user" and not message.get("askId"):
            content = clean_text(str(message.get("content", "")))
            if content:
                materials.append({
                    "kind": "message",
                    "name": message.get("id"),
                    "status": "extracted",
                    "text_preview": content[:1200],
                    "char_count": len(content),
                })
                combined.append(content)

    for item in manifest.get("files", []):
        path = Path(item["path"]).resolve()
        kind, text = extract_file(path)
        preview = clean_text(text)[:1600]
        status = "needs_review" if kind in {"pdf", "unsupported", "error"} else "extracted"
        materials.append({
            "kind": "file",
            "name": item.get("originalName"),
            "mime_type": item.get("mimeType"),
            "extractor": kind,
            "status": status,
            "text_preview": preview,
            "char_count": len(text),
        })
        combined.append(text)

    all_text = "\n".join(combined)
    digest = {
        "task_id": manifest["task"]["id"],
        "material_count": len(materials),
        "materials": materials,
        "signals": signals_from_text(all_text),
        "coverage_guess": {
            "has_responsibility_signal": bool(signals_from_text(all_text)["responsibility"]),
            "has_object_signal": bool(signals_from_text(all_text)["objects"]),
            "has_standard_signal": bool(signals_from_text(all_text)["standards"]),
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(digest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"materials": len(materials), "output": str(output_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
