"""Extract a deterministic source-level UI surface manifest.

The BRD test plan needs a stable partition map before many agents can write
tests in parallel. This script intentionally stays static and conservative:
it inventories obvious source-level surfaces (`data-action`, dialogs, settings
panels, page modules, prompt-input modules, file-editor modules) without
claiming runtime coverage.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[4]
APP_SRC = ROOT / "packages" / "app" / "src"


def _rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def _ts_files(root: Path) -> Iterable[Path]:
    yield from sorted(
        p
        for p in root.rglob("*")
        if p.suffix in {".ts", ".tsx"} and not p.name.endswith(".test.ts")
    )


def _extract_data_actions() -> list[dict[str, object]]:
    actions: dict[str, set[str]] = defaultdict(set)
    patterns = [
        re.compile(r"""data-action\s*=\s*["']([^"']+)["']"""),
        re.compile(r"""["']data-action["']\s*:\s*["']([^"']+)["']"""),
    ]
    for path in _ts_files(APP_SRC):
        text = path.read_text(encoding="utf-8")
        for pattern in patterns:
            for match in pattern.finditer(text):
                actions[match.group(1)].add(_rel(path))
    return [
        {"id": action, "files": sorted(files)}
        for action, files in sorted(actions.items())
    ]


def _components(glob: str) -> list[dict[str, str]]:
    out = []
    for path in sorted(APP_SRC.glob(glob)):
        out.append({"id": path.stem, "path": _rel(path)})
    return out


def build_manifest() -> dict[str, object]:
    return {
        "actions": _extract_data_actions(),
        "surfaces": {
            "dialogs": _components("components/dialog-*.tsx"),
            "settings": _components("components/settings-*.tsx"),
            "pages": _components("pages/**/*.tsx"),
            "promptInput": _components("components/prompt-input/**/*"),
            "fileEditor": _components("components/file-edit/**/*"),
            "session": _components("components/session/**/*.tsx")
            + _components("pages/session/**/*.tsx"),
        },
    }


def main() -> None:
    print(json.dumps(build_manifest(), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
