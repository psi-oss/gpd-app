"""Dynamic UI inventory and invariant helpers for manual exploration runs."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from gpd_tests.helpers import artifacts
from gpd_tests.helpers.dom_probe import DOMProbe, ProbeSkip


def _data(dom: DOMProbe, js: str) -> Any:
    raw = dom.eval(js)
    if raw is None:
        return None
    if not isinstance(raw, str):
        return raw
    return json.loads(raw)


def install(dom: DOMProbe) -> None:
    dom.eval(
        r"""
        (() => {
          const key = "__gpdExplorer";
          const state = window[key] || {
            installed: false,
            native: [],
            errors: [],
            rejected: [],
            actions: [],
            next: 0,
            original: {}
          };
          window[key] = state;
          if (state.installed) return true;
          state.installed = true;
          for (const name of ["alert", "confirm", "prompt"]) {
            state.original[name] = window[name];
            window[name] = (...args) => {
              state.native.push({
                name,
                args: args.map((v) => String(v)),
                url: location.href,
                at: Date.now()
              });
              throw new Error(`GPD explorer blocked native ${name}`);
            };
          }
          window.addEventListener("error", (event) => {
            state.errors.push({
              message: String(event.message || ""),
              source: String(event.filename || ""),
              line: event.lineno || 0,
              column: event.colno || 0,
              url: location.href,
              at: Date.now()
            });
          });
          window.addEventListener("unhandledrejection", (event) => {
            state.rejected.push({
              reason: String(event.reason && event.reason.stack || event.reason || ""),
              url: location.href,
              at: Date.now()
            });
          });
          return true;
        })()
        """
    )


def clear(dom: DOMProbe) -> None:
    dom.eval(
        r"""
        (() => {
          const state = window.__gpdExplorer;
          if (!state) return true;
          state.native = [];
          state.errors = [];
          state.rejected = [];
          state.actions = [];
          return true;
        })()
        """
    )


def collect(dom: DOMProbe, surface: str, *, scope: str | None = None) -> dict[str, Any]:
    root = json.dumps(scope)
    data = _data(
        dom,
        r"""
        (() => {
          const scope = __SCOPE__;
          const root = scope ? document.querySelector(scope) : document;
          if (!root) {
            return {
              url: location.href,
              title: document.title,
              bodyText: "",
              items: [],
              counts: {},
              missingScope: scope
            };
          }
          const state = window.__gpdExplorer || (window.__gpdExplorer = { next: 0 });
          const selector = [
            "button",
            "a[href]",
            "input",
            "textarea",
            "select",
            "summary",
            "[contenteditable='true']",
            "[data-action]",
            "[role='button']",
            "[role='link']",
            "[role='menuitem']",
            "[role='tab']",
            "[role='checkbox']",
            "[role='switch']",
            "[role='radio']",
            "[role='combobox']",
            "[role='textbox']"
          ].join(",");
          const seen = new Set();
          const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
          const visible = (el) => {
            const rect = el.getBoundingClientRect();
            const css = window.getComputedStyle(el);
            return rect.width > 0 &&
              rect.height > 0 &&
              css.display !== "none" &&
              css.visibility !== "hidden" &&
              css.pointerEvents !== "none";
          };
          const label = (el) => norm(
            el.getAttribute("data-action") ||
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            el.getAttribute("placeholder") ||
            el.getAttribute("value") ||
            el.innerText ||
            el.textContent ||
            el.id ||
            ""
          ).slice(0, 160);
          const category = (el, text) => {
            const hay = [
              text,
              el.getAttribute("data-action"),
              el.getAttribute("aria-label"),
              el.getAttribute("href")
            ].join(" ").toLowerCase();
            const tag = el.tagName.toLowerCase();
            const role = (el.getAttribute("role") || "").toLowerCase();
            const type = (el.getAttribute("type") || "").toLowerCase();
            if (el.disabled || el.getAttribute("aria-disabled") === "true") return "disabled";
            if (tag === "input" || tag === "textarea" || role === "textbox" || el.isContentEditable) return "input";
            if (role === "tab" || role === "menuitem" || tag === "summary") return "passive";
            if (el.getAttribute("aria-haspopup") || hay.includes("menu-open") || hay.includes("dropdown")) return "passive";
            if (/(delete|remove|revoke|reset|sign out|logout|log out|uninstall|archive|discard|take theirs|change api|disconnect)/.test(hay)) return "confirmable";
            if (/(open|browse|directory|folder|download|external|github|license|install|repair|choose|select file)/.test(hay)) return "external";
            if (tag === "a" || role === "link") return "external";
            if (type === "submit") return "action";
            return "action";
          };
          const items = Array.from(root.querySelectorAll(selector))
            .filter((el) => {
              if (seen.has(el)) return false;
              seen.add(el);
              return visible(el);
            })
            .map((el, index) => {
              const text = label(el);
              const id = el.getAttribute("data-gpd-explorer-id") || `gpd-explorer-${++state.next}`;
              el.setAttribute("data-gpd-explorer-id", id);
              const rect = el.getBoundingClientRect();
              return {
                id,
                index,
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute("role") || "",
                type: el.getAttribute("type") || "",
                action: el.getAttribute("data-action") || "",
                slot: el.getAttribute("data-slot") || "",
                aria: el.getAttribute("aria-label") || "",
                text,
                category: category(el, text),
                disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
                href: el.getAttribute("href") || "",
                selected: el.getAttribute("aria-selected") === "true",
                expanded: el.getAttribute("aria-expanded") || "",
                checked: el.getAttribute("aria-checked") || "",
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              };
            });
          const counts = items.reduce((acc, item) => {
            acc[item.category] = (acc[item.category] || 0) + 1;
            return acc;
          }, {});
          return {
            url: location.href,
            title: document.title,
            bodyText: norm(document.body && document.body.innerText).slice(0, 500),
            items,
            counts
          };
        })()
        """.replace("__SCOPE__", root),
    )
    data["surface"] = surface
    return data


def snapshot(dom: DOMProbe) -> dict[str, Any]:
    return _data(
        dom,
        r"""
        (() => {
          const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
          const labels = (selector) => Array.from(document.querySelectorAll(selector))
            .filter((el) => {
              const rect = el.getBoundingClientRect();
              const css = window.getComputedStyle(el);
              return rect.width > 0 &&
                rect.height > 0 &&
                css.display !== "none" &&
                css.visibility !== "hidden";
            })
            .map((el) => norm(
              el.getAttribute("data-action") ||
              el.getAttribute("aria-label") ||
              el.innerText ||
              el.textContent ||
              el.id ||
              el.tagName
            ))
            .filter(Boolean)
            .sort();
          const text = norm(document.body && document.body.innerText);
          const hash = Array.from(text).reduce((acc, ch) => ((acc * 33) ^ ch.charCodeAt(0)) >>> 0, 5381);
          return {
            url: location.href,
            textHash: hash,
            textLength: text.length,
            dialogs: document.querySelectorAll("[role='dialog'],[data-component='dialog']").length,
            overlays: document.querySelectorAll("[role='menu'],[role='listbox'],[data-slot='select-select-content-list'],[data-component='select-content']").length,
            tabs: labels("[role='tab'][aria-selected='true'],[data-slot='tabs-trigger'][aria-selected='true']"),
            active: document.activeElement ? norm(
              document.activeElement.getAttribute("data-action") ||
              document.activeElement.getAttribute("aria-label") ||
              document.activeElement.textContent ||
              document.activeElement.tagName
            ) : "",
            body: text.slice(0, 500)
          };
        })()
        """,
    )


def transitions(prev: dict[str, Any], next: dict[str, Any]) -> list[str]:
    keys = ["url", "textHash", "textLength", "dialogs", "overlays", "tabs", "active"]
    return [key for key in keys if prev.get(key) != next.get(key)]


def click(dom: DOMProbe, item: dict[str, Any]) -> dict[str, Any]:
    ident = json.dumps(item["id"])
    action = json.dumps(item.get("action") or "")
    label = json.dumps(item.get("text") or item.get("aria") or "")
    tag = json.dumps(item.get("tag") or "")
    role = json.dumps(item.get("role") or "")
    data = _data(
        dom,
        f"""
        (() => {{
          const id = {ident};
          const action = {action};
          const label = {label};
          const tag = {tag};
          const role = {role};
          const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
          let el = document.querySelector(`[data-gpd-explorer-id="${{id}}"]`);
          if (!el && action) {{
            el = document.querySelector(`[data-action="${{CSS.escape(action)}}"]`);
          }}
          if (!el && label) {{
            el = Array.from(document.querySelectorAll("button,a[href],summary,[role='button'],[role='menuitem'],[role='tab'],[data-action]"))
              .find((node) =>
                (!tag || node.tagName.toLowerCase() === tag) &&
                (!role || node.getAttribute("role") === role) &&
                norm(node.getAttribute("aria-label") || node.innerText || node.textContent) === label
              );
          }}
          if (!el) return {{ ok: false, reason: "missing", id }};
          const text = norm(el.innerText || el.textContent || el.getAttribute("aria-label") || "");
          const before = location.href;
          try {{
            el.scrollIntoView({{ block: "center", inline: "center" }});
            const opts = {{ bubbles: true, cancelable: true, view: window }};
            for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {{
              const event = type.startsWith("pointer") && window.PointerEvent
                ? new PointerEvent(type, opts)
                : new MouseEvent(type, opts);
              el.dispatchEvent(event);
            }}
            el.click();
            const state = window.__gpdExplorer;
            if (state) state.actions.push({{ id, text, before, after: location.href, at: Date.now() }});
            return {{ ok: true, id, text, before, after: location.href }};
          }} catch (err) {{
            return {{ ok: false, id, text, before, after: location.href, error: String(err && err.stack || err) }};
          }}
        }})()
        """,
    )
    return data


def input(dom: DOMProbe, item: dict[str, Any]) -> dict[str, Any]:
    ident = json.dumps(item["id"])
    data = _data(
        dom,
        f"""
        (() => {{
          const id = {ident};
          const el = document.querySelector(`[data-gpd-explorer-id="${{id}}"]`);
          if (!el) return {{ ok: false, reason: "missing", id }};
          const tag = el.tagName.toLowerCase();
          const type = String(el.getAttribute("type") || "").toLowerCase();
          const before = location.href;
          const old = tag === "input" || tag === "textarea" ? el.value : el.textContent;
          let mid = old;
          let last = old;
          try {{
            el.scrollIntoView({{ block: "center", inline: "center" }});
            el.focus();
            if (!["file", "checkbox", "radio", "submit", "button"].includes(type)) {{
              if (tag === "input" || tag === "textarea") {{
                el.value = `${{old || ""}} gpd-explorer`;
                el.dispatchEvent(new InputEvent("input", {{ bubbles: true, inputType: "insertText", data: " gpd-explorer" }}));
                mid = el.value;
                el.value = old || "";
                el.dispatchEvent(new InputEvent("input", {{ bubbles: true, inputType: "deleteContentBackward", data: null }}));
                el.dispatchEvent(new Event("change", {{ bubbles: true }}));
                last = el.value;
              }} else if (el.isContentEditable) {{
                el.textContent = `${{old || ""}} gpd-explorer`;
                el.dispatchEvent(new InputEvent("input", {{ bubbles: true, inputType: "insertText", data: " gpd-explorer" }}));
                mid = el.textContent;
                el.textContent = old || "";
                el.dispatchEvent(new InputEvent("input", {{ bubbles: true, inputType: "deleteContentBackward", data: null }}));
                last = el.textContent;
              }}
            }}
            return {{
              ok: true,
              id,
              before,
              after: location.href,
              active: document.activeElement === el,
              changed: mid !== old,
              restored: last === (old || "")
            }};
          }} catch (err) {{
            return {{ ok: false, id, before, after: location.href, error: String(err && err.stack || err) }};
          }}
        }})()
        """,
    )
    return data


def dismiss(dom: DOMProbe) -> None:
    dom.eval(
        r"""
        (() => {
          const norm = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
          const buttons = Array.from(document.querySelectorAll("button,[role='button']"));
          const cancel = buttons.find((el) => /^(cancel|no|keep editing|close|done)$/.test(norm(el.innerText || el.textContent || el.getAttribute("aria-label"))));
          if (cancel) cancel.click();
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
          if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
          return true;
        })()
        """
    )
    time.sleep(0.15)


def report(dom: DOMProbe) -> dict[str, Any]:
    try:
        return _data(
            dom,
            r"""
            (() => {
              const state = window.__gpdExplorer || {};
              const text = String(document.body && document.body.innerText || "").replace(/\s+/g, " ").trim();
              const problems = [
                "JSON Parse error",
                "Couldn't refresh",
                "Select an agent and model",
                "Choose an agent and model",
                "Unterminated string"
              ].filter((item) => text.includes(item));
              return {
                url: location.href,
                native: state.native || [],
                errors: state.errors || [],
                rejected: state.rejected || [],
                actions: state.actions || [],
                problems,
                bodyLength: text.length,
                dialogs: document.querySelectorAll("[role='dialog'],[data-component='dialog']").length,
                text: text.slice(0, 500),
                bridgeTimeout: ""
              };
            })()
            """,
        )
    except ProbeSkip as err:
        return {
            "url": "",
            "native": [],
            "errors": [],
            "rejected": [],
            "actions": [],
            "problems": [],
            "bodyLength": 0,
            "dialogs": 0,
            "text": "",
            "bridgeTimeout": str(err),
        }


def check(dom: DOMProbe, label: str) -> None:
    out = report(dom)
    assert not out.get("bridgeTimeout"), f"{label}: JS bridge timed out: {out['bridgeTimeout']!r}"
    assert out["bodyLength"] > 0, f"{label}: document body is empty"
    assert not out["native"], f"{label}: native modal API used: {out['native']!r}"
    assert not out["errors"], f"{label}: uncaught JS errors: {out['errors']!r}"
    assert not out["rejected"], f"{label}: unhandled rejections: {out['rejected']!r}"
    assert not out["problems"], f"{label}: visible error toasts/messages: {out['problems']!r}; text={out['text']!r}"


def root() -> Path:
    env = os.environ.get("GPD_EXPLORER_ARTIFACT_DIR")
    if env:
        path = Path(env)
        path.mkdir(parents=True, exist_ok=True)
        return path
    return artifacts.artifact_dir("explorer", "manual-full")


def save(name: str, data: object) -> Path:
    return artifacts.save_json(root(), name, data)
