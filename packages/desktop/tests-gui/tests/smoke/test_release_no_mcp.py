"""Release-build-only smoke check: confirm the MCP socket is absent.

This is the regression-safety net for the fix in
`packages/desktop/src-tauri/src/lib.rs` (#[cfg(debug_assertions)] gate on
`tauri_plugin_mcp::init_with_config`) and for the Vite-side tree-shake
driven by the __GPD_TAURI_DEBUG__ define in `packages/desktop/vite.config.ts`.

Opt-in via PYTEST_RELEASE_BUILD=1 because all other smoke tests require
the MCP socket and would error out in fixture setup.
"""
from __future__ import annotations

import glob
import os
import subprocess
from pathlib import Path

import pytest


RELEASE_BUILD = os.environ.get("PYTEST_RELEASE_BUILD") == "1"


def _bundle_id(app_path: str) -> str:
    out = subprocess.run(
        [
            "/usr/libexec/PlistBuddy",
            "-c",
            "Print CFBundleIdentifier",
            f"{app_path}/Contents/Info.plist",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return out.stdout.strip() if out.returncode == 0 else ""


def _socket_matches() -> list[str]:
    return glob.glob("/var/folders/**/tauri-mcp.sock", recursive=True)


def _gpd_pid() -> int | None:
    out = subprocess.run(
        ["pgrep", "-f", ".app/Contents/MacOS/GPD"],
        capture_output=True,
        text=True,
        check=False,
    )
    pids = [int(x) for x in out.stdout.split() if x.strip().isdigit()]
    return pids[0] if pids else None


def _contains_any(path: Path, needles: tuple[bytes, ...]) -> bytes | None:
    """Return the first matching needle in path without shelling out to CLT tools.

    Clean macOS VMs do not have Xcode Command Line Tools. Commands like
    `/usr/bin/strings` are CLT stubs and open a GUI installer prompt, which
    invalidates release-lane tests. Scan bytes directly instead.
    """
    window = max(len(n) for n in needles) - 1
    tail = b""
    with path.open("rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                return None
            data = tail + chunk
            for needle in needles:
                if needle in data:
                    return needle
            tail = data[-window:] if window > 0 else b""


@pytest.mark.smoke
@pytest.mark.skipif(
    not RELEASE_BUILD,
    reason="release-mode assertion; opt in via PYTEST_RELEASE_BUILD=1 "
    "after launching a release-built GPD with GPD_APP_PATH pointed at it",
)
def test_release_build_has_no_mcp_socket():
    pid = _gpd_pid()
    assert pid is not None, (
        "no GPD process running — launch the release build first "
        '(e.g. `open "$GPD_APP_PATH"`)'
    )
    app_path_env = os.environ.get("GPD_APP_PATH", "")
    bundle_id = _bundle_id(app_path_env) if app_path_env else ""
    if bundle_id in ("inc.psi.gpd.dev", "inc.psi.gpd.beta"):
        pytest.skip(
            f"skipping release-socket check: bundle id {bundle_id!r} is not a release build"
        )
    assert bundle_id == "inc.psi.gpd", (
        "GPD_APP_PATH does not point at a release build: "
        f"bundle id {bundle_id!r} (from {app_path_env!r}) — a debug or beta build "
        "WOULD expose the socket and this test's assertion would be meaningless"
    )
    sockets = _socket_matches()
    assert not sockets, (
        "SECURITY REGRESSION: MCP socket is present under a release build. "
        f"Found: {sockets}. The plugin MUST be gated behind "
        "`#[cfg(debug_assertions)]` in src-tauri/src/lib.rs."
    )


@pytest.mark.smoke
@pytest.mark.skipif(
    not RELEASE_BUILD,
    reason="release-mode assertion; opt in via PYTEST_RELEASE_BUILD=1",
)
def test_release_build_frontend_bundle_has_no_vendor_code():
    """Confirms Vite tree-shook the vendored tauri-plugin-mcp out of the
    release frontend bundle. If the vendor module leaks into release
    assets, our defense-in-depth guarantee weakens — even without the
    Rust-side plugin, the addEventListener monkey-patch would still ship.
    """
    app_path = os.environ.get("GPD_APP_PATH", "")
    if not app_path:
        pytest.skip("GPD_APP_PATH not set; cannot locate release bundle")
    app = Path(app_path)
    if not app.exists():
        pytest.skip(f"GPD_APP_PATH does not exist: {app}")

    sentinels = (b"__TAURI_MCP_LISTENER_PATCH__", b"setupPluginListeners")
    scan_roots = [
        app / "Contents" / "MacOS" / "GPD",
        app / "Contents" / "Resources",
    ]
    offenders: list[tuple[str, str]] = []
    for root in scan_roots:
        paths = [root] if root.is_file() else [p for p in root.rglob("*") if p.is_file()]
        for path in paths:
            hit = _contains_any(path, sentinels)
            if hit:
                offenders.append((str(path.relative_to(app)), hit.decode()))
    assert not offenders, (
        "SECURITY REGRESSION: vendored tauri-plugin-mcp leaked into the "
        f"release frontend bundle. Offenders: {offenders}. Verify the "
        "__GPD_TAURI_DEBUG__ define in vite.config.ts stayed `false` for "
        "non-debug builds."
    )
