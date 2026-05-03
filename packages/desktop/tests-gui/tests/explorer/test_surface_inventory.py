from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any

import pytest

from gpd_tests.helpers import explorer
from gpd_tests.helpers.dom_probe import DOMProbe, ProbeSkip
from gpd_tests.helpers.navigator import (
    Navigator,
    encode_dir_token,
    route_home,
    route_project,
    route_session_in_project,
)


def _session_id(data: dict[str, Any]) -> str:
    return str(data.get("id") or data.get("sessionID") or data.get("session_id") or "")


def _limit(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return max(0, int(raw))
    except ValueError:
        return default


def _strict() -> bool:
    return os.environ.get("GPD_EXPLORER_STRICT") == "1"


def _change(dom: DOMProbe, prev: dict[str, Any], timeout: float = 1.5) -> tuple[list[str], dict[str, Any]]:
    deadline = time.monotonic() + timeout
    last = explorer.snapshot(dom)
    while time.monotonic() < deadline:
        last = explorer.snapshot(dom)
        diff = [item for item in explorer.transitions(prev, last) if item != "active"]
        if diff:
            return diff, last
        time.sleep(0.1)
    return [], last


def _until(fn, timeout: float = 3.0):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(0.1)
    return last


def _body(dom: DOMProbe) -> str:
    return str(dom.eval("document.body && document.body.innerText || ''") or "")


def _auth() -> bytes:
    base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
    try:
        return (base / "opencode" / "auth.json").read_bytes()
    except FileNotFoundError:
        return b""


def _static_actions() -> list[str]:
    root = Path(__file__).resolve().parents[5]
    out = set()
    for file in (root / "packages/app/src").rglob("*.tsx"):
        text = file.read_text(encoding="utf-8")
        for match in re.finditer(r"""data-action\s*=\s*["']([^"']+)["']""", text):
            out.add(match.group(1))
    return sorted(out)


def _assert_inventory(snap: dict[str, Any]) -> None:
    items = snap["items"]
    assert items, f"{snap['surface']}: no visible interactive elements found"
    bad = [
        item for item in items
        if not item["disabled"] and not (item["text"] or item["action"] or item["aria"])
    ]
    assert not bad, f"{snap['surface']}: unlabeled visible controls: {bad!r}"


def _open_settings(dom: DOMProbe) -> None:
    try:
        opened = dom.eval_bool(
            r"""
            (() => {
              const existing = Array.from(document.querySelectorAll("[role='tab']")).some((el) =>
                String(el.textContent || "").trim() === "General"
              );
              if (existing) return true;
              const btn = document.querySelector(
                "[aria-label='Settings'],[data-action='settings'],button[title='Settings']"
              );
              if (!btn) return false;
              btn.click();
              return true;
            })()
            """
        )
    except ProbeSkip as err:
        pytest.skip(f"execute_js unavailable ({err})")
    if not opened:
        pytest.skip("settings opener not found")

    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        try:
            ready = dom.eval_bool(
                r"""
                (() => Array.from(document.querySelectorAll("[role='tab']")).some((el) =>
                  String(el.textContent || "").trim() === "General"
                ))()
                """
            )
        except ProbeSkip as err:
            pytest.skip(f"execute_js unavailable ({err})")
        if ready:
            return
        time.sleep(0.1)
    pytest.fail("settings dialog did not expose the General tab")


def _seeded(mcp, http, explorer_project_dir) -> list[tuple[str, str]]:
    session = http.create_session(directory=str(explorer_project_dir))
    sid = _session_id(session)
    token = encode_dir_token(str(explorer_project_dir))
    routes = [
        ("home", route_home()),
        ("project", route_project(str(explorer_project_dir))),
        ("session-list", route_session_in_project(token)),
    ]
    if sid:
        routes.append(("session-detail", route_session_in_project(token, sid)))
    return routes


def _collect_routes(mcp, http, explorer_project_dir) -> list[dict[str, Any]]:
    nav = Navigator(mcp)
    dom = DOMProbe(mcp)
    out: list[dict[str, Any]] = []
    for name, url in _seeded(mcp, http, explorer_project_dir):
        nav.go(url, timeout_s=7.0)
        explorer.install(dom)
        explorer.clear(dom)
        snap = explorer.collect(dom, name)
        explorer.check(dom, name)
        _assert_inventory(snap)
        out.append(snap)
    return out


def _collect_settings(dom: DOMProbe) -> list[dict[str, Any]]:
    _open_settings(dom)
    explorer.install(dom)
    base = explorer.collect(dom, "settings", scope="[role='dialog']")
    _assert_inventory(base)
    out = [base]
    tabs = [
        item for item in base["items"]
        if item["role"] == "tab" or item["slot"] == "tabs-trigger"
    ]
    for tab in tabs:
        explorer.clear(dom)
        res = explorer.click(dom, tab)
        assert res["ok"], f"settings tab click failed: {res!r}"
        time.sleep(0.2)
        label = tab["text"] or tab["action"] or tab["id"]
        snap = explorer.collect(dom, f"settings:{label}", scope="[role='dialog']")
        explorer.check(dom, f"settings:{label}")
        _assert_inventory(snap)
        out.append(snap)
    return out


def _click_passive(dom: DOMProbe, snap: dict[str, Any], clicked: list[dict[str, Any]], budget: int) -> None:
    for item in snap["items"]:
        if len(clicked) >= budget:
            return
        if item["category"] != "passive":
            continue
        if item.get("selected"):
            continue
        explorer.clear(dom)
        prev = explorer.snapshot(dom)
        res = explorer.click(dom, item)
        if not res["ok"] and res.get("reason") == "missing":
            continue
        assert res["ok"], f"{snap['surface']}: passive click failed: {res!r}"
        diff, next = _change(dom, prev)
        diff = [item for item in diff if item != "active"]
        assert diff, (
            f"{snap['surface']}: passive click had no observable transition: "
            f"item={item!r}; before={prev!r}; after={next!r}"
        )
        explorer.check(dom, f"{snap['surface']} -> {item['text'] or item['id']}")
        explorer.dismiss(dom)
        clicked.append({"surface": snap["surface"], "item": item, "result": res, "transitions": diff})


def _exercise_inputs(dom: DOMProbe, snap: dict[str, Any], seen: list[dict[str, Any]], budget: int) -> None:
    for item in snap["items"]:
        if len(seen) >= budget:
            return
        if item["category"] != "input":
            continue
        if item.get("type") in {"file", "checkbox", "radio", "submit", "button"}:
            continue
        explorer.clear(dom)
        res = explorer.input(dom, item)
        if not res["ok"] and res.get("reason") == "missing":
            continue
        assert res["ok"], f"{snap['surface']}: input exercise failed: {res!r}"
        assert res.get("changed"), f"{snap['surface']}: input did not accept reversible text: item={item!r}; result={res!r}"
        assert res.get("restored"), f"{snap['surface']}: input was not restored after edit: item={item!r}; result={res!r}"
        time.sleep(0.1)
        explorer.check(dom, f"{snap['surface']} -> input {item['text'] or item['id']}")
        explorer.dismiss(dom)
        seen.append({"surface": snap["surface"], "item": item, "result": res})


@pytest.mark.explorer
@pytest.mark.surfaces
def test_seeded_surfaces_have_labeled_interactive_inventory(mcp, http, explorer_project_dir):
    """Inventory every visible control in the core seeded states.

    This is the high-signal "are we even seeing the whole app?" gate. It does
    not claim exhaustive state-space coverage; it records the rendered control
    universe for the current seed and fails if controls are invisible,
    unlabeled, or the app trips native-modal/JS-error invariants while mounting.
    """
    dom = DOMProbe(mcp)
    data = _collect_routes(mcp, http, explorer_project_dir)
    data.extend(_collect_settings(dom))

    total = sum(len(snap["items"]) for snap in data)
    counts: dict[str, int] = {}
    for snap in data:
        for key, value in snap["counts"].items():
            counts[key] = counts.get(key, 0) + int(value)

    report = {
        "total": total,
        "counts": counts,
        "surfaces": data,
    }
    static = _static_actions()
    seen = sorted({
        item["action"]
        for snap in data
        for item in snap["items"]
        if item["action"]
    })
    report["dataActionCoverage"] = {
        "static": len(static),
        "seen": len(seen),
        "missing": [item for item in static if item not in seen],
        "seenActions": seen,
    }
    explorer.save("inventory.json", report)

    minimum = _limit("GPD_EXPLORER_MIN_CONTROLS", 60)
    assert total >= minimum, (
        f"interactive inventory is unexpectedly small: {total} < {minimum}. "
        "This usually means the app is blocked by onboarding, TOS, or a blank route."
    )


@pytest.mark.explorer
@pytest.mark.surfaces
def test_explorer_clicks_reversible_controls(mcp, http, explorer_project_dir):
    """Click all currently visible passive controls within the action budget."""
    nav = Navigator(mcp)
    dom = DOMProbe(mcp)
    budget = _limit("GPD_EXPLORER_MAX_ACTIONS", 120)
    clicked = []

    for name, url in _seeded(mcp, http, explorer_project_dir):
        if len(clicked) >= budget:
            break
        nav.go(url, timeout_s=7.0)
        explorer.install(dom)
        snap = explorer.collect(dom, name)
        _click_passive(dom, snap, clicked, budget)

    if len(clicked) < budget:
        _open_settings(dom)
        explorer.install(dom)
        snap = explorer.collect(dom, "settings", scope="[role='dialog']")
        _click_passive(dom, snap, clicked, budget)
        tabs = [
            item for item in snap["items"]
            if item["role"] == "tab" or item["slot"] == "tabs-trigger"
        ]
        for tab in tabs:
            if len(clicked) >= budget:
                break
            explorer.click(dom, tab)
            time.sleep(0.2)
            label = tab["text"] or tab["action"] or tab["id"]
            tab_snap = explorer.collect(dom, f"settings:{label}", scope="[role='dialog']")
            _click_passive(dom, tab_snap, clicked, budget)

    explorer.save("passive-clicks.json", clicked)
    if _strict():
        assert clicked, "strict explorer mode expected at least one passive control click"


@pytest.mark.explorer
@pytest.mark.surfaces
def test_explorer_exercises_visible_inputs(mcp, http, explorer_project_dir):
    """Focus and reversibly edit visible text inputs/contenteditable controls."""
    nav = Navigator(mcp)
    dom = DOMProbe(mcp)
    budget = _limit("GPD_EXPLORER_MAX_INPUTS", 80)
    seen = []

    for name, url in _seeded(mcp, http, explorer_project_dir):
        if len(seen) >= budget:
            break
        nav.go(url, timeout_s=7.0)
        explorer.install(dom)
        snap = explorer.collect(dom, name)
        _exercise_inputs(dom, snap, seen, budget)

    if len(seen) < budget:
        _open_settings(dom)
        explorer.install(dom)
        snap = explorer.collect(dom, "settings", scope="[role='dialog']")
        _exercise_inputs(dom, snap, seen, budget)
        tabs = [
            item for item in snap["items"]
            if item["role"] == "tab" or item["slot"] == "tabs-trigger"
        ]
        for tab in tabs:
            if len(seen) >= budget:
                break
            explorer.click(dom, tab)
            time.sleep(0.2)
            label = tab["text"] or tab["action"] or tab["id"]
            tab_snap = explorer.collect(dom, f"settings:{label}", scope="[role='dialog']")
            _exercise_inputs(dom, tab_snap, seen, budget)

    explorer.save("inputs.json", seen)
    if _strict():
        assert seen, "strict explorer mode expected at least one visible input"


@pytest.mark.explorer
@pytest.mark.surfaces
def test_change_api_key_requires_confirmation_and_cancel_preserves_session(mcp, http, explorer_project_dir):
    """Changing the API key is destructive and must be cancelable."""
    dom = DOMProbe(mcp)
    _collect_routes(mcp, http, explorer_project_dir)
    _open_settings(dom)
    explorer.install(dom)
    snap = explorer.collect(dom, "settings", scope="[role='dialog']")
    item = next((item for item in snap["items"] if item["text"] == "Change API key"), None)
    assert item, "settings did not expose Change API key"

    key = _auth()
    url = mcp.current_url()
    res = explorer.click(dom, item)
    assert res["ok"], f"Change API key click failed: {res!r}"
    assert _until(lambda: "Cancel" in _body(dom)), "Change API key did not show a cancelable confirmation"
    assert "Welcome to GPD" not in _body(dom), "Change API key signed out before confirmation"

    explorer.dismiss(dom)
    explorer.check(dom, "change-api-key cancel")
    assert mcp.current_url() == url, "canceling Change API key changed route"
    assert _auth() == key, "canceling Change API key modified auth.json"
    explorer.save("change-api-key.json", {
        "clicked": True,
        "cancelled": True,
        "route": url,
        "authBytes": len(key),
    })


@pytest.mark.explorer
@pytest.mark.surfaces
def test_confirmable_controls_never_use_native_modal_apis(mcp, http, explorer_project_dir):
    """Open destructive/confirmable controls and cancel them.

    This directly targets the mac WebKit class that caused the stuck revoke
    consent popup: a product handler using window.confirm/window.alert instead
    of an app-owned confirmation surface.
    """
    dom = DOMProbe(mcp)
    _collect_routes(mcp, http, explorer_project_dir)
    budget = _limit("GPD_EXPLORER_MAX_CONFIRMABLE", 40)
    seen = []

    def hit(snap: dict[str, Any]) -> None:
        for item in snap["items"]:
            if len(seen) >= budget:
                return
            if item["category"] != "confirmable":
                continue
            explorer.clear(dom)
            res = explorer.click(dom, item)
            if not res["ok"] and res.get("reason") == "missing":
                continue
            assert res["ok"], f"{snap['surface']}: confirmable opener failed: {res!r}"
            time.sleep(0.2)
            out = explorer.report(dom)
            assert not out.get("bridgeTimeout"), (
                f"{snap['surface']} -> {item['text'] or item['action']}: "
                f"JS bridge timed out after confirmable click: {out['bridgeTimeout']!r}"
            )
            assert not out["native"], (
                f"{snap['surface']} -> {item['text'] or item['action']}: "
                f"used native modal API: {out['native']!r}"
            )
            explorer.dismiss(dom)
            explorer.check(dom, f"{snap['surface']} -> cancel {item['text'] or item['id']}")
            seen.append({"surface": snap["surface"], "item": item, "result": res})

    _open_settings(dom)
    explorer.install(dom)
    snap = explorer.collect(dom, "settings", scope="[role='dialog']")
    hit(snap)
    tabs = [
        item for item in snap["items"]
        if item["role"] == "tab" or item["slot"] == "tabs-trigger"
    ]
    for tab in tabs:
        if len(seen) >= budget:
            break
        explorer.click(dom, tab)
        time.sleep(0.2)
        label = tab["text"] or tab["action"] or tab["id"]
        hit(explorer.collect(dom, f"settings:{label}", scope="[role='dialog']"))

    explorer.save("confirmable-clicks.json", seen)
    if _strict():
        assert seen, "strict explorer mode expected at least one confirmable control"
