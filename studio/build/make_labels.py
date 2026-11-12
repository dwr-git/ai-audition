#!/usr/bin/env python3
"""Russian names for the assistant's command search.

Reads the Russian interface table AI Звук is built with (crates/ui-egui/src/ru.tsv: English, a
tab, Russian; `#` starts a comment) and writes studio/ru-labels.json:

    {"text": {"Bounce Mix": "Свести микс", ...}}

The assistant panel uses it to show and search commands (their labels and menu-path segments) in
Russian. Run by studio/build/package.sh.
"""

import json
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    src = root / "crates" / "ui-egui" / "src" / "ru.tsv"
    dst = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("ru-labels.json")
    text: dict[str, str] = {}
    if not src.is_file():
        print(f"warning: {src} not found; command names stay English", file=sys.stderr)
    else:
        for line in src.read_text(encoding="utf-8").splitlines():
            if not line.strip() or line.startswith("#") or "\t" not in line:
                continue
            en, ru = line.split("\t", 1)
            if en and ru.strip():
                text[en] = ru.strip()
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps({"text": text, "id": {}}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{dst}: {len(text)} labels")
    return 0


if __name__ == "__main__":
    sys.exit(main())
