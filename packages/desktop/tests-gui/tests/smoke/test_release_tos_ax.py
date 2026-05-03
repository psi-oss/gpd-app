"""Release-build macOS AX smoke check for the TOS consent gate.

This test intentionally drives the installed app, not the debug MCP bridge:
release builds must not expose MCP. It seeds the already-authenticated path
(`auth.json` present, no accepted TOS version in WebKit localStorage) so the
product renders `TosUpgradeGate`, then verifies a real macOS scroll-wheel event
can scroll both embedded legal documents and enable the consent controls.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest


RELEASE_BUILD = os.environ.get("PYTEST_RELEASE_BUILD") == "1"
RESET_ENABLED = os.environ.get("GPD_RELEASE_ONBOARDING_RESET") == "1"


def _run(cmd: list[str], *, timeout_s: float = 20.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout_s,
        check=False,
    )


def _osascript(script: str, *, timeout_s: float = 10.0) -> str:
    r = subprocess.run(
        ["/usr/bin/osascript"],
        input=script,
        capture_output=True,
        text=True,
        timeout=timeout_s,
        check=False,
    )
    if r.returncode != 0:
        raise RuntimeError(f"osascript failed: {r.stderr.strip()}")
    return r.stdout.strip()


def _jxa(script: str, *, timeout_s: float = 10.0) -> str:
    r = subprocess.run(
        ["/usr/bin/osascript", "-l", "JavaScript"],
        input=script,
        capture_output=True,
        text=True,
        timeout=timeout_s,
        check=False,
    )
    if r.returncode != 0:
        raise RuntimeError(f"osascript -l JavaScript failed: {r.stderr.strip()}")
    return r.stdout.strip()


def _bundle_id(app_path: Path) -> str:
    r = _run(
        [
            "/usr/libexec/PlistBuddy",
            "-c",
            "Print CFBundleIdentifier",
            str(app_path / "Contents" / "Info.plist"),
        ],
    )
    return r.stdout.strip() if r.returncode == 0 else ""


def _release_app_path() -> Path:
    return Path(os.environ.get("GPD_APP_PATH", "/Applications/GPD.app"))


def _seed_key() -> str:
    # The release smoke completes the server-side TOS acceptance path, so
    # this must be a real LiteLLM key when the full test is enabled.
    return (
        os.environ.get("GPD_TEST_KEY")
        or os.environ.get("GPD_API_KEY")
        or os.environ.get("GPD_EXPLORER_KEY")
        or "sk-test-release-onboarding"
    )


def _reset_to_tos_upgrade_gate(app_path: Path) -> None:
    _run(["/usr/bin/osascript", "-e", 'tell application "GPD" to quit'], timeout_s=5.0)
    time.sleep(1.0)
    _run(["/usr/bin/pkill", "-f", ".app/Contents/MacOS/GPD"], timeout_s=5.0)
    _run(["/usr/bin/pkill", "-f", "opencode-cli"], timeout_s=5.0)

    home = Path.home()
    bundle_id = "inc.psi.gpd"
    for path in [
        home / "Library" / "Application Support" / bundle_id,
        home / "Library" / "WebKit" / bundle_id,
        home / "Library" / "Caches" / bundle_id,
        home / "Library" / "Logs" / bundle_id,
        home / "Library" / "HTTPStorages" / bundle_id,
        home / "Library" / "Saved Application State" / f"{bundle_id}.savedState",
    ]:
        shutil.rmtree(path, ignore_errors=True)

    config_dir = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
    data_dir = Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share"))
    sentinel = config_dir / "gpd" / ".gpd-initialized"
    auth_json = data_dir / "opencode" / "auth.json"
    sentinel.parent.mkdir(parents=True, exist_ok=True)
    auth_json.parent.mkdir(parents=True, exist_ok=True)
    sentinel.write_text("seeded-by-release-tos-ax\n")
    auth_json.write_text(json.dumps({"gpd": {"type": "api", "key": _seed_key()}}) + "\n")
    auth_json.chmod(0o600)

    r = _run(["/usr/bin/open", "-n", str(app_path)], timeout_s=10.0)
    if r.returncode != 0:
        raise RuntimeError(f"open {app_path} failed: {r.stderr.strip()}")


def _wait_until(predicate, *, timeout_s: float = 20.0, interval_s: float = 0.25) -> None:
    deadline = time.monotonic() + timeout_s
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            if predicate():
                return
        except Exception as e:  # noqa: BLE001
            last_error = e
        time.sleep(interval_s)
    if last_error is not None:
        raise TimeoutError(f"condition not met within {timeout_s}s: {last_error}") from last_error
    raise TimeoutError(f"condition not met within {timeout_s}s")


def _consent_state() -> dict[str, str]:
    raw = _osascript(
        r'''
        using terms from application "System Events"
          tell application "System Events"
            tell process "GPD"
              set w to UI element 1 of scroll area 1 of group 1 of group 1 of window 1
              set tosBox to checkbox 1 of UI element 5 of w
              set privacyBox to checkbox 1 of UI element 8 of w
              set agreeButton to button "I Agree" of w
              return "tosEnabled=" & (enabled of tosBox as text) & ¬
                "|tosValue=" & (value of tosBox as text) & ¬
                "|privacyEnabled=" & (enabled of privacyBox as text) & ¬
                "|privacyValue=" & (value of privacyBox as text) & ¬
                "|agreeEnabled=" & (enabled of agreeButton as text)
            end tell
          end tell
        end using terms from
        ''',
        timeout_s=10.0,
    )
    state: dict[str, str] = {}
    for part in raw.split("|"):
        if "=" in part:
            key, value = part.split("=", 1)
            state[key] = value
    return state


def _gate_visible() -> bool:
    try:
        state = _consent_state()
    except Exception:
        return False
    return {
        "tosEnabled",
        "tosValue",
        "privacyEnabled",
        "privacyValue",
        "agreeEnabled",
    }.issubset(state)


def _scroll_wheel_at(x: int, y: int, *, lines: int = -10, steps: int = 30) -> None:
    # System Events exposes WebKit's custom scroll regions as AXGroup, not
    # AXScrollArea. A real CoreGraphics scroll-wheel event is the reliable
    # release-build primitive and matches what users do with a trackpad/mouse.
    _jxa(
        f'''
        ObjC.import('CoreGraphics')
        ObjC.import('Foundation')
        function sleep(ms) {{ $.NSThread.sleepForTimeInterval(ms / 1000) }}
        $.CGWarpMouseCursorPosition($.CGPointMake({x}, {y}))
        sleep(100)
        for (let i = 0; i < {steps}; i++) {{
          const ev = $.CGEventCreateScrollWheelEvent(null, 1, 1, {lines})
          $.CGEventPost(0, ev)
          sleep(25)
        }}
        ''',
        timeout_s=10.0,
    )


def _press_checkbox(parent_index: int) -> None:
    _osascript(
        f'''
        using terms from application "System Events"
          tell application "System Events"
            tell process "GPD"
              set w to UI element 1 of scroll area 1 of group 1 of group 1 of window 1
              perform action "AXPress" of checkbox 1 of UI element {parent_index} of w
            end tell
          end tell
        end using terms from
        ''',
        timeout_s=10.0,
    )


def _press_agree() -> None:
    _osascript(
        '''
        using terms from application "System Events"
          tell application "System Events"
            tell process "GPD"
              set w to UI element 1 of scroll area 1 of group 1 of group 1 of window 1
              perform action "AXPress" of button "I Agree" of w
            end tell
          end tell
        end using terms from
        ''',
        timeout_s=10.0,
    )


@pytest.mark.smoke
@pytest.mark.skipif(
    not RELEASE_BUILD,
    reason="release-mode assertion; opt in via PYTEST_RELEASE_BUILD=1",
)
@pytest.mark.skipif(sys.platform != "darwin", reason="macOS AX release smoke only")
@pytest.mark.skipif(
    not RESET_ENABLED,
    reason="destructive release onboarding reset is opt-in via GPD_RELEASE_ONBOARDING_RESET=1",
)
def test_release_tos_gate_scrolls_both_documents_and_accepts_terms():
    app_path = _release_app_path()
    assert app_path.exists(), f"GPD_APP_PATH does not exist: {app_path}"
    assert _bundle_id(app_path) == "inc.psi.gpd", (
        f"GPD_APP_PATH must point at the release app, got {_bundle_id(app_path)!r}"
    )
    if _seed_key() == "sk-test-release-onboarding":
        pytest.skip("set GPD_TEST_KEY, GPD_API_KEY, or GPD_EXPLORER_KEY for full TOS accept")

    _reset_to_tos_upgrade_gate(app_path)
    _wait_until(_gate_visible, timeout_s=30.0)

    initial = _consent_state()
    assert initial["tosEnabled"] == "false"
    assert initial["privacyEnabled"] == "false"
    assert initial["agreeEnabled"] == "false"

    _scroll_wheel_at(856, 323, steps=35)
    _wait_until(lambda: _consent_state()["tosEnabled"] == "true", timeout_s=5.0)
    _press_checkbox(5)

    _scroll_wheel_at(856, 629, steps=60)
    _wait_until(lambda: _consent_state()["privacyEnabled"] == "true", timeout_s=5.0)
    _press_checkbox(8)

    final = _consent_state()
    assert final["tosValue"] == "1"
    assert final["privacyValue"] == "1"
    assert final["agreeEnabled"] == "true"

    _press_agree()
    _wait_until(lambda: not _gate_visible(), timeout_s=20.0)
