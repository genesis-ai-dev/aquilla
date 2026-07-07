#!/usr/bin/env python3
"""FROZEN (F7) — independent OOXML structural validator for the round-trip scorer.

Uses ONLY the Python standard library (zipfile, xml.dom.minidom, re) so it shares
no assumptions with the jszip/DOMParser stack the exporters are built on (F4).

usage: ooxml-check.py <original> <exported> <docx|pptx>
prints: {"ok": bool, "reason": str}
"""
import json
import re
import sys
import zipfile
from xml.dom import minidom


def fail(reason: str) -> None:
    print(json.dumps({"ok": False, "reason": reason}))
    sys.exit(0)


def main() -> None:
    orig_path, export_path, kind = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        zo = zipfile.ZipFile(orig_path)
    except Exception as e:  # noqa: BLE001
        fail(f"original not a zip: {e}")
    try:
        zx = zipfile.ZipFile(export_path)
    except Exception as e:  # noqa: BLE001
        fail(f"export not a zip: {e}")

    orig_parts = set(zo.namelist())
    export_parts = set(zx.namelist())
    missing = orig_parts - export_parts
    if missing:
        fail(f"export missing {len(missing)} original part(s): {sorted(missing)[:5]}")

    # Every XML part in the export must be well-formed.
    for name in sorted(export_parts):
        if not name.endswith((".xml", ".rels")):
            continue
        try:
            minidom.parseString(zx.read(name))
        except Exception as e:  # noqa: BLE001
            fail(f"export part {name} not well-formed XML: {e}")

    # Text-bearing structure must be preserved.
    if kind == "docx":
        part = "word/document.xml"
        pattern = re.compile(rb"<w:p[ >/]")
    else:
        part = None
        pattern = re.compile(rb"<a:t[ >]")

    if kind == "docx":
        co = len(pattern.findall(zo.read(part)))
        cx = len(pattern.findall(zx.read(part)))
        if co != cx:
            fail(f"w:p count changed: {co} -> {cx}")
    else:
        def count_slides(z: zipfile.ZipFile) -> dict:
            out = {}
            for name in z.namelist():
                if re.match(r"ppt/slides/slide\d+\.xml$", name):
                    out[name] = len(pattern.findall(z.read(name)))
            return out

        so, sx = count_slides(zo), count_slides(zx)
        if set(so) != set(sx):
            fail(f"slide part set changed: {sorted(so)} -> {sorted(sx)}")
        for name in so:
            if so[name] != sx[name]:
                fail(f"a:t count changed in {name}: {so[name]} -> {sx[name]}")

    print(json.dumps({"ok": True}))


if __name__ == "__main__":
    main()
