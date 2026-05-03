#!/usr/bin/env python3
"""Validate that a manual exploration run did useful app work."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def _load(root: Path, name: str):
    path = root / name
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _count(data) -> int:
    if isinstance(data, list):
        return len(data)
    return 0


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(os.environ["GPD_EXPLORER_ARTIFACT_DIR"])
    real = os.environ.get("GPD_EXPLORER_RUN_REAL_BACKEND") == "1"
    report = {
        "ok": True,
        "errors": [],
        "metrics": {},
    }

    scenario = _load(root, "scenario.json")
    inventory = _load(root, "inventory.json")
    clicks = _load(root, "passive-clicks.json")
    inputs = _load(root, "inputs.json")
    confirm = _load(root, "confirmable-clicks.json")
    key = _load(root, "change-api-key.json")
    prompt = _load(root, "semantic-prompt-controls.json")
    settings = _load(root, "semantic-settings.json")

    if not isinstance(scenario, dict):
        report["errors"].append("scenario.json missing")
    else:
        stages = scenario.get("stages") if isinstance(scenario.get("stages"), list) else []
        report["metrics"]["scenarioStages"] = stages
        for stage in [
            "session-created",
            "composer-controls",
            "composer-typed",
            "model-selector",
            "agent-selector",
            "settings-opened",
            "settings:Licenses",
            "returned-session",
        ]:
            if stage not in stages:
                report["errors"].append(f"scenario stage missing: {stage}")
        if not scenario.get("useful"):
            report["errors"].append("scenario did not mark run useful")
        if real and "assistant-replied" not in stages:
            report["errors"].append("real-backend run did not receive assistant reply")
        if real and int(scenario.get("assistantChars") or 0) < 20:
            report["errors"].append("assistant reply too small to prove useful chat")
        roles = scenario.get("roles") if isinstance(scenario.get("roles"), list) else []
        if real and ("user" not in roles or "assistant" not in roles):
            report["errors"].append(f"chat roles missing user/assistant: {roles}")

    if not isinstance(inventory, dict):
        report["errors"].append("inventory.json missing")
    else:
        total = int(inventory.get("total") or 0)
        report["metrics"]["inventoryTotal"] = total
        if total < int(os.environ.get("GPD_EXPLORER_MIN_CONTROLS", "60")):
            report["errors"].append(f"inventory too small: {total}")

    report["metrics"]["passiveClicks"] = _count(clicks)
    if _count(clicks) < int(os.environ.get("GPD_EXPLORER_MIN_PASSIVE", "8")):
        report["errors"].append(f"too few passive clicks: {_count(clicks)}")
    moved = [
        item for item in clicks or []
        if isinstance(item, dict) and item.get("transitions")
    ]
    report["metrics"]["passiveTransitions"] = len(moved)
    if len(moved) < int(os.environ.get("GPD_EXPLORER_MIN_TRANSITIONS", "5")):
        report["errors"].append(f"too few passive clicks caused UI transitions: {len(moved)}")

    report["metrics"]["inputs"] = _count(inputs)
    if _count(inputs) < int(os.environ.get("GPD_EXPLORER_MIN_INPUTS_USEFUL", "2")):
        report["errors"].append(f"too few input exercises: {_count(inputs)}")
    bad = [
        item for item in inputs or []
        if not (
            isinstance(item, dict) and
            isinstance(item.get("result"), dict) and
            item["result"].get("changed") and
            item["result"].get("restored")
        )
    ]
    if bad:
        report["errors"].append(f"input exercises without changed+restored proof: {len(bad)}")

    report["metrics"]["confirmableClicks"] = _count(confirm)
    if _count(confirm) < int(os.environ.get("GPD_EXPLORER_MIN_CONFIRMABLE", "1")):
        report["errors"].append(f"too few confirmable clicks: {_count(confirm)}")

    if not isinstance(key, dict) or not key.get("clicked") or not key.get("cancelled"):
        report["errors"].append("Change API key confirmation/cancel artifact missing")

    if not isinstance(prompt, dict):
        report["errors"].append("semantic-prompt-controls.json missing")
    else:
        for name in ["gpdSkills", "equation", "model", "agent"]:
            if not isinstance(prompt.get(name), dict) or not prompt[name]:
                report["errors"].append(f"semantic prompt control missing: {name}")
        report["metrics"]["semanticPromptControls"] = [
            name for name in ["gpdSkills", "equation", "model", "agent"]
            if isinstance(prompt.get(name), dict) and prompt[name]
        ]

    if not isinstance(settings, dict):
        report["errors"].append("semantic-settings.json missing")
    else:
        toggles = settings.get("toggles") if isinstance(settings.get("toggles"), list) else []
        report["metrics"]["semanticSettingsToggles"] = len(toggles)
        if len(toggles) < int(os.environ.get("GPD_EXPLORER_MIN_SEMANTIC_TOGGLES", "3")):
            report["errors"].append(f"too few semantic settings toggles: {len(toggles)}")
        bad = [
            item for item in toggles
            if not (
                isinstance(item, dict) and
                item.get("mid") != item.get("before") and
                item.get("after") == item.get("before")
            )
        ]
        if bad:
            report["errors"].append(f"settings toggles without changed+restored proof: {len(bad)}")

    report["ok"] = not report["errors"]
    (root / "usefulness.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if report["ok"]:
        print("usefulness: ok")
        return 0
    print("usefulness: failed")
    for err in report["errors"]:
        print(f"- {err}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
