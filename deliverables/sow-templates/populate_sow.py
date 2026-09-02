#!/usr/bin/env python3
"""Populate every tagged Word content control in an Aquilla SOW template."""

from __future__ import annotations

import argparse
import json
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}


def fill_part(data: bytes, values: dict[str, str]) -> bytes:
    root = ET.fromstring(data)
    changed = False
    for sdt in root.findall(".//w:sdt", NS):
        tag = sdt.find("./w:sdtPr/w:tag", NS)
        if tag is None:
            continue
        key = tag.get(f"{{{W}}}val")
        if key not in values:
            continue
        content = sdt.find("./w:sdtContent", NS)
        if content is None:
            continue
        texts = content.findall(".//w:t", NS)
        if not texts:
            continue
        texts[0].text = str(values[key])
        for extra in texts[1:]:
            extra.text = ""
        changed = True
    if not changed:
        return data
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def populate(template: Path, data_file: Path, output: Path) -> None:
    values = json.loads(data_file.read_text(encoding="utf-8"))
    with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as handle:
        temp = Path(handle.name)
    try:
        with zipfile.ZipFile(template, "r") as source, zipfile.ZipFile(
            temp, "w", zipfile.ZIP_DEFLATED
        ) as target:
            for item in source.infolist():
                content = source.read(item.filename)
                if item.filename == "word/document.xml" or (
                    item.filename.startswith("word/header")
                    or item.filename.startswith("word/footer")
                ) and item.filename.endswith(".xml"):
                    content = fill_part(content, values)
                target.writestr(item, content)
        output.parent.mkdir(parents=True, exist_ok=True)
        temp.replace(output)
    finally:
        temp.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fill an Aquilla SOW template from one deal-data JSON file."
    )
    parser.add_argument("template", type=Path)
    parser.add_argument("deal_data", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    populate(args.template, args.deal_data, args.output)
    print(args.output.resolve())


if __name__ == "__main__":
    main()
