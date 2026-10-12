#!/usr/bin/env python3
"""Build the Deepify capacity report from a load snapshot.

    python3 build_report.py load-snapshot.json out.html

The template is self-contained HTML; the snapshot JSON is embedded, so the
report is one file that opens anywhere and can be dropped into ChampBeam Pages.
"""
import json
import pathlib
import sys

here = pathlib.Path(__file__).parent
snap_path, out_path = sys.argv[1], sys.argv[2]
snap = json.loads(pathlib.Path(snap_path).read_text())
# Escape the one sequence that can break out of a <script type=json> block.
payload = json.dumps(snap, separators=(",", ":")).replace("</", "<\\/")
html = (here / "template.html").read_text().replace("__SNAPSHOT__", payload)
pathlib.Path(out_path).write_text(html)
print(f"wrote {out_path} ({len(html)//1024} KB)")
