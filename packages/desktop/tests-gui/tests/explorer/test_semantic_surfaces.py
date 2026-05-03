from __future__ import annotations

import json
import time
from typing import Any

import pytest

from gpd_tests.helpers import explorer
from gpd_tests.helpers.dom_probe import DOMProbe
from gpd_tests.helpers.navigator import Navigator, encode_dir_token, route_session_in_project


def _session(data: dict[str, Any]) -> str:
    return str(data.get("id") or data.get("sessionID") or data.get("session_id") or "")


def _eval(dom: DOMProbe, js: str):
    raw = dom.eval(js)
    if isinstance(raw, str) and raw[:1] in "[{":
        return json.loads(raw)
    return raw


def _wait(fn, timeout: float = 10.0):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    return last


def _click(dom: DOMProbe, action: str) -> None:
    assert _wait(
        lambda: dom.eval_bool(f"""(() => !!document.querySelector(`[data-action="{action}"]`))()"""),
        timeout=5.0,
    ), f"missing data-action={action}"
    ok = dom.eval_bool(
        f"""
        (() => {{
          const el = document.querySelector(`[data-action="{action}"]`);
          if (!el) return false;
          el.scrollIntoView({{ block: "center", inline: "center" }});
          const opts = {{ bubbles: true, cancelable: true, view: window }};
          for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {{
            const event = type.startsWith("pointer") && window.PointerEvent
              ? new PointerEvent(type, opts)
              : new MouseEvent(type, opts);
            el.dispatchEvent(event);
          }}
          el.click();
          return true;
        }})()
        """
    )
    assert ok, f"missing data-action={action}"
    time.sleep(0.2)


def _body(dom: DOMProbe) -> str:
    return str(dom.eval("document.body && document.body.innerText || ''") or "")


def _prompt(dom: DOMProbe) -> str:
    return str(dom.eval(
        r"""
        (() => {
          const el = document.querySelector("[data-component='prompt-input'][contenteditable]");
          return el ? String(el.textContent || "") : "";
        })()
        """
    ) or "")


def _clear(dom: DOMProbe) -> None:
    ok = dom.eval_bool(
        r"""
        (() => {
          const el = document.querySelector("[data-component='prompt-input'][contenteditable]");
          if (!el) return false;
          el.focus();
          el.textContent = "";
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
          return true;
        })()
        """
    )
    assert ok, "prompt editor missing"


def _ready(dom: DOMProbe):
    return _eval(
        dom,
        r"""
        (() => {
          const text = (action) => {
            const el = document.querySelector(`[data-action="${action}"]`);
            return el ? String(el.textContent || el.getAttribute("aria-label") || "").trim() : "";
          };
          const btn = document.querySelector("button[data-action='prompt-submit']");
          if (!btn) return false;
          if (!text("prompt-agent")) return false;
          if (!text("prompt-model") || text("prompt-model") === "Select model") return false;
          return {
            agent: text("prompt-agent"),
            model: text("prompt-model"),
            variant: text("prompt-model-variant"),
            submitDisabled: btn.disabled || btn.getAttribute("aria-disabled") === "true"
          };
        })()
        """,
    )


def _route(mcp, http, dir) -> tuple[DOMProbe, str]:
    sid = _session(http.create_session(directory=str(dir)))
    assert sid, "create_session returned no id"
    Navigator(mcp).go(route_session_in_project(encode_dir_token(str(dir)), sid), timeout_s=8.0)
    dom = DOMProbe(mcp)
    explorer.install(dom)
    assert _wait(lambda: _ready(dom), timeout=20.0), "composer never reached send-ready state"
    return dom, sid


def _select_skill(dom: DOMProbe) -> str:
    return str(dom.eval(
        r"""
        (() => {
          const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
          const visible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const node = Array.from(document.querySelectorAll("[role='dialog'] [data-slot='list-item'],[data-slot='dialog-body'] [data-slot='list-item']"))
            .filter(visible)
            .find((el) => /\/gpd-[a-z0-9-]+/.test(norm(el.innerText || el.textContent)));
          if (!node) return "";
          const text = norm(node.innerText || node.textContent);
          node.scrollIntoView({ block: "center", inline: "center" });
          node.click();
          return text.match(/\/gpd-[a-z0-9-]+/)?.[0] || text;
        })()
        """
    ) or "")


def _insert_equation(dom: DOMProbe) -> dict[str, Any]:
    return _eval(
        dom,
        r"""
        (() => {
          const field = document.querySelector("math-field");
          if (!field) {
            return {
              ok: false,
              reason: "missing-field",
              text: String(document.body && document.body.innerText || "").slice(0, 500)
            };
          }
          field.focus();
          if (typeof field.insert === "function") field.insert("\\alpha+\\beta");
          else if (typeof field.setValue === "function") field.setValue("\\alpha+\\beta");
          else field.value = "\\alpha+\\beta";
          field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "\\alpha+\\beta" }));
          const value = typeof field.getValue === "function" ? field.getValue("latex") : String(field.value || "");
          if (!String(value || "").trim()) return { ok: false, reason: "empty-field-value" };
          const btn = Array.from(document.querySelectorAll("button"))
            .find((el) => /^(Insert|Insert Equation)$/.test(String(el.innerText || el.textContent || "").trim()));
          if (!btn) return { ok: false, reason: "missing-insert" };
          btn.click();
          return { ok: true, value };
        })()
        """,
    )


def _popover(dom: DOMProbe) -> bool:
    return dom.eval_bool(
        r"""
        (() => !!document.querySelector(
          "[role='dialog'],[data-component='list'],[data-component='select-content'],[data-slot='select-select-content-list'],[role='listbox'],[role='menu']"
        ))()
        """
    )


def _settings(dom: DOMProbe) -> None:
    opened = dom.eval_bool(
        r"""
        (() => {
          const existing = Array.from(document.querySelectorAll("[role='tab']")).some((el) =>
            String(el.textContent || "").trim() === "General"
          );
          if (existing) return true;
          const btn = document.querySelector("[aria-label='Settings'],[data-action='settings'],button[title='Settings']");
          if (!btn) return false;
          btn.click();
          return true;
        })()
        """
    )
    assert opened, "settings opener missing"
    assert _wait(
        lambda: dom.eval_bool(
            r"""
            (() => Array.from(document.querySelectorAll("[role='tab']")).some((el) =>
              String(el.textContent || "").trim() === "General"
            ))()
            """
        ),
        timeout=5.0,
    ), "settings did not expose General tab"


def _switch_value(dom: DOMProbe, action: str) -> dict[str, Any]:
    return _eval(
        dom,
        f"""
        (() => {{
          const root = document.querySelector(`[data-action="{action}"]`);
          if (!root) return {{ ok: false, reason: "missing-root" }};
          const input = root.querySelector("[data-slot='switch-input'],input");
          const sw = root.querySelector("[data-component='switch'],[role='switch']");
          if (!input && !sw) return {{ ok: false, reason: "missing-switch" }};
          if (input && "checked" in input) return {{ ok: true, value: !!input.checked }};
          return {{ ok: true, value: sw.getAttribute("aria-checked") === "true" }};
        }})()
        """,
    )


def _switch_click(dom: DOMProbe, action: str) -> dict[str, Any]:
    return _eval(
        dom,
        f"""
        (() => {{
          const root = document.querySelector(`[data-action="{action}"]`);
          const value = () => {{
            const input = root?.querySelector("[data-slot='switch-input'],input");
            if (input && "checked" in input) return !!input.checked;
            const sw = root?.querySelector("[data-component='switch'],[role='switch']");
            return sw?.getAttribute("aria-checked") === "true";
          }};
          const fire = (el) => {{
            if (!el) return false;
            el.scrollIntoView({{ block: "center", inline: "center" }});
            const opts = {{ bubbles: true, cancelable: true, view: window }};
            for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {{
              el.dispatchEvent(new MouseEvent(type, opts));
            }}
            el.click();
            return true;
          }};
          const before = value();
          const el = root?.querySelector("[data-slot='switch-control'],[role='switch'],button,input");
          if (!root || !el) return {{ ok: false, reason: "missing" }};
          fire(el);
          if (value() === before) fire(root.querySelector("[data-slot='switch-input'],input"));
          return {{ ok: true, before, after: value() }};
        }})()
        """,
    )


def _switch(dom: DOMProbe, action: str) -> dict[str, Any]:
    before = _switch_value(dom, action)
    if not before.get("ok"):
        return before

    res = _switch_click(dom, action)
    if not res.get("ok"):
        return res
    mid = _wait(
        lambda: (
            {"value": _switch_value(dom, action).get("value")}
            if _switch_value(dom, action).get("value") != before.get("value")
            else None
        ),
        timeout=2.0,
    )

    res = _switch_click(dom, action)
    if not res.get("ok"):
        return res
    after = _wait(
        lambda: (
            {"value": _switch_value(dom, action).get("value")}
            if _switch_value(dom, action).get("value") == before.get("value")
            else None
        ),
        timeout=2.0,
    )
    now = _switch_value(dom, action)
    return {
        "ok": True,
        "action": action,
        "before": before.get("value"),
        "mid": mid.get("value") if isinstance(mid, dict) else now.get("value"),
        "after": after.get("value") if isinstance(after, dict) else now.get("value"),
    }


@pytest.mark.explorer
@pytest.mark.surfaces
def test_prompt_auxiliary_controls_have_semantic_effects(mcp, http, explorer_project_dir):
    """Controls below the composer must do their product jobs, not just open."""
    dom, sid = _route(mcp, http, explorer_project_dir)
    out = {
        "session": sid,
        "gpdSkills": {},
        "equation": {},
        "model": {},
        "agent": {},
    }

    _click(dom, "prompt-gpd-skills")
    assert _wait(
        lambda: dom.eval_bool(
            "(() => !!document.querySelector(\"[role='dialog'] [data-slot='list-item']\"))()"
        ),
        timeout=5.0,
    ), f"GPD Skills dialog did not list selectable commands; body={_body(dom)[:500]!r}"
    skill = _select_skill(dom)
    assert skill.startswith("/gpd-"), f"GPD Skills command not selectable; selected={skill!r}"
    assert _wait(lambda: _prompt(dom).strip().startswith(skill), timeout=3.0), (
        f"GPD Skills did not populate prompt; skill={skill!r}; prompt={_prompt(dom)!r}"
    )
    out["gpdSkills"] = {"selected": skill, "prompt": _prompt(dom)}
    explorer.check(dom, "semantic:gpd-skills")
    _clear(dom)

    _click(dom, "prompt-equation")
    assert _wait(lambda: dom.eval_bool("!!document.querySelector('[data-testid=\"gpd-equation-editor\"]')"), timeout=5.0), (
        "equation dialog did not open"
    )
    assert _wait(lambda: dom.eval_bool("!!document.querySelector('math-field')"), timeout=12.0), (
        f"MathLive field did not load; body={_body(dom)[:500]!r}"
    )
    eq = _insert_equation(dom)
    assert eq.get("ok"), f"equation insert failed: {eq!r}"
    assert _wait(lambda: "$$" in _prompt(dom) and "alpha" in _prompt(dom) and "beta" in _prompt(dom), timeout=3.0), (
        f"equation did not insert LaTeX into prompt; prompt={_prompt(dom)!r}"
    )
    out["equation"] = {"prompt": _prompt(dom)}
    explorer.check(dom, "semantic:equation")
    _clear(dom)

    _click(dom, "prompt-model")
    assert _wait(lambda: _popover(dom), timeout=3.0), f"model selector did not open; body={_body(dom)[:500]!r}"
    body = _body(dom)
    assert "Connect provider" in body or "Manage" in body or "Search" in body or "Models" in body, (
        f"model selector opened without selector content; body={body[:500]!r}"
    )
    out["model"] = {"opened": True, "body": body[:500]}
    explorer.check(dom, "semantic:model-selector")
    explorer.dismiss(dom)

    _click(dom, "prompt-agent")
    assert _wait(lambda: _popover(dom), timeout=3.0), f"agent selector did not open; body={_body(dom)[:500]!r}"
    body = _body(dom)
    assert "Build" in body, f"agent selector missing Build agent; body={body[:500]!r}"
    out["agent"] = {"opened": True, "body": body[:500]}
    explorer.check(dom, "semantic:agent-selector")
    explorer.dismiss(dom)

    explorer.save("semantic-prompt-controls.json", out)


@pytest.mark.explorer
@pytest.mark.surfaces
def test_settings_general_switches_have_semantic_effects(mcp, http, explorer_project_dir):
    """Settings switches must flip state and restore state on a second click."""
    dom, sid = _route(mcp, http, explorer_project_dir)
    _settings(dom)
    data = {
        "session": sid,
        "toggles": [],
    }

    for action in [
        "settings-feed-reasoning-summaries",
        "settings-feed-shell-tool-parts-expanded",
        "settings-feed-edit-tool-parts-expanded",
    ]:
        explorer.clear(dom)
        res = _switch(dom, action)
        assert res.get("ok"), f"{action}: switch missing: {res!r}"
        assert res.get("mid") != res.get("before"), f"{action}: switch did not change state: {res!r}"
        assert res.get("after") == res.get("before"), f"{action}: switch did not restore state: {res!r}"
        explorer.check(dom, f"semantic:settings:{action}")
        data["toggles"].append(res)

    explorer.save("semantic-settings.json", data)
