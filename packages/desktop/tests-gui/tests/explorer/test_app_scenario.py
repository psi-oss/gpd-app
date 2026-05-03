from __future__ import annotations

import json
import os
import time

import pytest

from gpd_tests.helpers import explorer
from gpd_tests.helpers.dom_probe import DOMProbe
from gpd_tests.helpers.llm_tolerant import wait_for_assistant_text
from gpd_tests.helpers.navigator import Navigator, encode_dir_token, route_session_in_project
from gpd_tests.helpers.navigator import route_project


def _session(data) -> str:
    return str(data.get("id") or data.get("sessionID") or data.get("session_id") or "")


def _eval(dom: DOMProbe, js: str):
    raw = dom.eval(js)
    if isinstance(raw, str) and raw[:1] in "[{":
        return json.loads(raw)
    return raw


def _click(dom: DOMProbe, action: str) -> None:
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


def _present(dom: DOMProbe, action: str) -> bool:
    return dom.eval_bool(
        f"""
        (() => !!document.querySelector(`[data-action="{action}"]`))()
        """
    )


def _composer(dom: DOMProbe) -> dict:
    return _eval(
        dom,
        r"""
        (() => {
          const text = (action) => {
            const el = document.querySelector(`[data-action="${action}"]`);
            return el ? String(el.textContent || el.getAttribute("aria-label") || "").trim() : "";
          };
          const btn = document.querySelector("button[data-action='prompt-submit']");
          return {
            agent: text("prompt-agent"),
            model: text("prompt-model"),
            variant: text("prompt-model-variant"),
            submit: !!btn,
            disabled: !btn || btn.disabled || btn.getAttribute("aria-disabled") === "true",
          };
        })()
        """,
    )


def _ready(dom: DOMProbe) -> dict | None:
    state = _composer(dom)
    if not state.get("submit"):
        return None
    if not state.get("agent"):
        return None
    if not state.get("model") or state.get("model") == "Select model":
        return None
    return state


def _wait(fn, *, timeout: float = 10.0):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    return last


def _actions(dom: DOMProbe) -> list[str]:
    return _eval(
        dom,
        r"""
        (() => Array.from(document.querySelectorAll("[data-action]"))
          .map((el) => el.getAttribute("data-action"))
          .filter(Boolean)
          .sort())()
        """,
    )


def _text(dom: DOMProbe) -> str:
    return str(dom.eval("document.body && document.body.innerText || ''") or "")


def _prompt(dom: DOMProbe) -> str:
    raw = dom.eval(
        r"""
        (() => {
          const el = document.querySelector("[data-component='prompt-input'][contenteditable]");
          return el ? String(el.textContent || "") : "";
        })()
        """
    )
    return str(raw or "")


def _popover(dom: DOMProbe) -> bool:
    return dom.eval_bool(
        r"""
        (() => !!document.querySelector(
          "[data-component='select-content'],[data-slot='select-select-content-list'],[role='listbox'],[role='menu']"
        ))()
        """
    )


def _roles(http, sid: str) -> list[str]:
    return [
        str((msg.get("info") or {}).get("role") or "")
        for msg in http.messages(sid)
        if isinstance(msg, dict)
    ]


def _submitted(http, sid: str, before: int) -> bool:
    return len(_roles(http, sid)) > before and "user" in _roles(http, sid)


def _submit(dom: DOMProbe, http, sid: str) -> bool:
    before = len(_roles(http, sid))
    dom.eval_bool(
        r"""
        (() => {
          const btn = document.querySelector("button[data-action='prompt-submit']");
          if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
          const form = btn.closest("form");
          if (!form || !form.requestSubmit) return false;
          form.requestSubmit(btn);
          return true;
        })()
        """
    )
    return bool(_wait(lambda: _submitted(http, sid, before), timeout=30.0))


def _dismiss(dom: DOMProbe) -> None:
    explorer.dismiss(dom)
    time.sleep(0.2)


def _close(dom: DOMProbe) -> None:
    closed = dom.eval_bool(
        r"""
        (() => {
          const dialogs = Array.from(document.querySelectorAll("[role='dialog']"));
          const dialog = dialogs.at(-1);
          if (!dialog) return true;
          const buttons = Array.from(dialog.querySelectorAll("button,[role='button']"));
          const btn = buttons.find((el) => {
            const text = String(el.textContent || el.getAttribute("aria-label") || "").trim().toLowerCase();
            return text === "close" || text === "done" || text === "cancel";
          });
          if (btn) {
            btn.click();
            return true;
          }
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
          return true;
        })()
        """
    )
    assert closed, "failed to close active dialog"
    time.sleep(0.2)


def _normal_mode(mcp) -> None:
    try:
        mcp.execute_js(
            '(() => { const cmd = window.__OPENCODE__?.commands?.get?.("prompt.mode.normal"); '
            'if (cmd) cmd.execute?.(); return true; })()'
        )
    except Exception:
        pass


def _save(data: dict) -> None:
    explorer.save("scenario.json", data)


@pytest.mark.explorer
@pytest.mark.surfaces
@pytest.mark.timeout(240)
def test_logged_in_core_app_scenario(mcp, http, explorer_project_dir):
    """Drive a deterministic logged-in path once.

    This complements the inventory crawler. It is intentionally boring and
    specific: get to a real session, assert core controls, type into the
    composer without sending to the model, open model/settings surfaces once,
    and record what was covered.
    """
    seen = {
        "useful": False,
        "project": str(explorer_project_dir),
        "stages": [],
    }
    _save(seen)

    session = http.create_session(directory=str(explorer_project_dir))
    sid = _session(session)
    assert sid, f"create_session returned no id: {session!r}"
    seen["session"] = sid
    seen["stages"].append("session-created")
    _save(seen)

    nav = Navigator(mcp)
    token = encode_dir_token(str(explorer_project_dir))
    nav.go(route_project(str(explorer_project_dir)), timeout_s=8.0)
    seen["stages"].append("project-route")
    _save(seen)
    nav.go(route_session_in_project(token, sid), timeout_s=8.0)
    _normal_mode(mcp)
    dom = DOMProbe(mcp)
    explorer.install(dom)
    ready = _wait(lambda: _ready(dom), timeout=20.0)
    seen["currentUrl"] = str(mcp.current_url())
    seen["sessionActions"] = _actions(dom)
    seen["composer"] = _composer(dom)
    seen["sessionBody"] = _text(dom)[:800]
    _save(seen)
    assert ready, (
        "session did not reach send-ready composer state; "
        f"composer={seen['composer']!r}; actions={seen['sessionActions']!r}; "
        f"body={seen['sessionBody']!r}"
    )

    explorer.check(dom, "scenario:session")
    seen["sessionActions"] = _actions(dom)
    for action in ["prompt-agent", "prompt-model", "prompt-submit"]:
        assert action in seen["sessionActions"], f"session missing {action}"
    seen["stages"].append("composer-controls")
    _save(seen)

    typed = dom.eval_bool(
        r"""
        (() => {
          const el = document.querySelector("[data-component='prompt-input'][contenteditable]");
          if (!el) return false;
          el.focus();
          el.textContent = "Summarize this test project in one sentence";
          const range = document.createRange();
          const sel = window.getSelection();
          range.selectNodeContents(el);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        })()
        """
    )
    assert typed, "composer not found"
    enabled = _wait(lambda: dom.eval_bool(
        r"""
        (() => {
          const btn = document.querySelector("button[data-action='prompt-submit']");
          return !!btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
        })()
        """
    ), timeout=5.0)
    assert enabled, "prompt-submit did not enable after typing"
    seen["stages"].append("composer-typed")
    _save(seen)

    if os.environ.get("GPD_EXPLORER_RUN_REAL_BACKEND") == "1":
        assert _submit(dom, http, sid), (
            "prompt did not submit; "
            f"prompt={_prompt(dom)!r}; roles={_roles(http, sid)!r}"
        )
        assert _wait(lambda: _prompt(dom).strip() == "", timeout=5.0), (
            "prompt DOM did not clear after submit; "
            f"prompt={_prompt(dom)!r}"
        )
        seen["stages"].append("chat-submitted")
        _save(seen)
        text = wait_for_assistant_text(http, sid, timeout_s=120.0, skip_on_timeout=False)
        seen["assistantChars"] = len(text)
        seen["assistantPreview"] = text[:300]
        seen["roles"] = _roles(http, sid)
        seen["stages"].append("assistant-replied")
        _save(seen)
        assert "user" in seen["roles"], f"chat missing persisted user message: roles={seen['roles']!r}"
        assert "assistant" in seen["roles"], f"chat missing persisted assistant message: roles={seen['roles']!r}"
        assert "Summarize this test project in one sentence" in _text(dom), "submitted prompt was not visible in session UI"
        explorer.check(dom, "scenario:assistant-replied")
    else:
        dom.eval_bool(
            r"""
            (() => {
              const el = document.querySelector("[data-component='prompt-input'][contenteditable]");
              if (!el) return false;
              el.textContent = "";
              el.dispatchEvent(new Event("input", { bubbles: true }));
              return true;
            })()
            """
        )

    _click(dom, "prompt-model")
    text = _text(dom)
    assert "Models" in text or "model" in text.lower(), "model selector did not open"
    seen["modelDialogText"] = text[:500]
    _dismiss(dom)
    seen["stages"].append("model-selector")
    _save(seen)

    _click(dom, "prompt-agent")
    text = _text(dom)
    assert _wait(lambda: _popover(dom), timeout=3.0), f"agent selector did not open; body={text[:500]!r}"
    seen["agentDialogText"] = text[:500]
    _dismiss(dom)
    seen["stages"].append("agent-selector")
    _save(seen)

    opened = dom.eval_bool(
        r"""
        (() => {
          const el = document.querySelector("[aria-label='Settings']");
          if (!el) return false;
          el.click();
          return true;
        })()
        """
    )
    assert opened, "settings button not found"
    time.sleep(0.3)
    settings = explorer.collect(dom, "scenario:settings", scope="[role='dialog']")
    explorer.check(dom, "scenario:settings")
    assert settings["items"], "settings dialog has no interactive inventory"
    seen["settingsItems"] = len(settings["items"])
    seen["settingsActions"] = [item["action"] for item in settings["items"] if item["action"]]
    seen["stages"].append("settings-opened")
    _save(seen)

    for label in ["General", "Shortcuts", "AI Services", "Models", "Required Tools", "Licenses"]:
        hit = dom.eval_bool(
            f"""
            (() => {{
              const tab = Array.from(document.querySelectorAll("[role='tab']")).find((el) =>
                String(el.textContent || "").trim() === {json.dumps(label)}
              );
              if (!tab) return false;
              tab.click();
              return true;
            }})()
            """
        )
        assert hit, f"settings tab missing: {label}"
        time.sleep(0.15)
        explorer.check(dom, f"scenario:settings:{label}")
        seen["stages"].append(f"settings:{label}")
        _save(seen)

    _close(dom)
    nav.go(route_session_in_project(token, sid), timeout_s=8.0)
    assert _wait(lambda: _present(dom, "prompt-submit"), timeout=5.0), "failed to return to session after settings"
    seen["stages"].append("returned-session")
    seen["useful"] = True
    explorer.save("scenario.json", seen)
