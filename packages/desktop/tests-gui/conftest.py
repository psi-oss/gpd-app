"""Session-scoped fixtures for opencode-gpd-test.

- `app_state` — launches GPD at session start, quits at session end.
- `mcp`, `http`, `ax`, `os_input` — driver instances bound to the live app.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional

import pytest

REPO_ROOT = Path(__file__).parent
sys.path.insert(0, str(REPO_ROOT))

from gpd_tests.helpers import artifacts
from gpd_tests.helpers.timings import wait_until


# Module-level reference to the session-scoped AppState, set by the fixture.
_session_app_state: Optional["AppState"] = None  # noqa: F821


# --- Build-skew detector (task #91) --------------------------------------

# Sentinel Tauri command chosen from gpd_tests/fixtures/tauri_commands.json.
# `check_project_accessible` landed on 2026-04-20, right after the
# full-coverage sweep that surfaced 5 stale-binary regressions. Missing it
# at session start is a reliable signal that the running GPD debug binary
# is older than the current Rust source.
_BUILD_SKEW_SENTINEL = "check_project_accessible"

_BUILD_SKEW_MESSAGE = (
    "Build-skew detected: Tauri command {sentinel!r} is not "
    "registered in the running GPD binary.\n"
    "Your debug build is older than the current source. Run:\n"
    "    cd packages/desktop && bun run tauri build --debug\n"
    "Then relaunch GPD Dev.app and rerun the tests."
)


def _check_build_skew(mcp_factory, *, sentinel: str = _BUILD_SKEW_SENTINEL):
    """Probe one Tauri command to detect a stale GPD debug binary.

    Extracted from the `_build_skew_detector` fixture so it can be exercised
    directly from unit tests without going through pytest's fixture machinery.

    Semantics:
      - If `mcp_factory()` raises (no MCP reachable / no GPD running), this
        returns silently so the fixtures that actually need MCP handle the
        skip. A session-start probe must not fail when GPD simply isn't up.
      - If `invoke_via_mcp(..., sentinel, {})` raises IPCError whose message
        contains "not found" or "unknown", we interpret that as a stale
        binary and call `pytest.exit(...)` with a one-liner rebuild hint.
      - Any other IPCError (missing arg, invalid shape) means the command
        IS registered and the binary is fresh — that's the success path.
    """
    try:
        from gpd_tests.helpers.ipc import IPCError, invoke_via_mcp
    except ImportError:
        return

    try:
        mcp = mcp_factory()
        mcp.ping()
    except Exception:
        # No GPD / no MCP socket / auth problem — let the downstream fixtures
        # that actually need MCP produce the appropriate skip or failure.
        return

    try:
        # Short deadline — this is a session-start probe, not a real call.
        # If the webview bridge is unresponsive for any reason (race with
        # webview mount, leftover state from a prior test blowing up the
        # vendored plugin listener, MCP socket momentarily blocked), we
        # want to log and continue rather than cascade-error every test.
        invoke_via_mcp(mcp, sentinel, {}, deadline_s=3.0)
    except IPCError as e:
        msg = str(e).lower()
        if "not found" in msg or "unknown" in msg:
            pytest.exit(
                _BUILD_SKEW_MESSAGE.format(sentinel=sentinel),
                returncode=3,
            )
        # Other IPCError shapes (arg-validation, etc.) mean the command is
        # registered and the binary is fresh. Swallow and return.
    except Exception as e:  # noqa: BLE001
        # MCPTimeout, connection refused, anything else. A timeout here is
        # not a signal that the binary is stale — it's a signal that the
        # webview isn't responding. Surface as a warning and let the test
        # fixtures that actually need MCP handle the real failure.
        import warnings
        warnings.warn(
            f"build-skew probe inconclusive ({type(e).__name__}: {e!r}). "
            "Downstream MCP-dependent tests may fail at fixture setup; "
            "this is not a stale-binary signal. Check the running GPD Dev "
            "webview's state (tauri-plugin-mcp listener may be dead — "
            "typically recovers with a relaunch).",
            stacklevel=2,
        )


@pytest.fixture(scope="session", autouse=True)
def _build_skew_detector(request):
    """Fail fast if the debug binary is missing a recently-added Tauri command.

    The full catalog is at gpd_tests/fixtures/tauri_commands.json. We only
    probe ONE sentinel — ``check_project_accessible`` — which was added after
    the 2026-04-20 full-coverage sweep. If that command is missing at
    session start, every ipc test that depends on it will fail with
    "Command not found". Surfacing this once is much cheaper than N
    per-command failures.

    Skipped if MCP isn't reachable (no GPD running — covered by other
    fixtures). Skipped for pure `-m unit` runs (no webview, no binary
    involved).
    """
    # Only run when an ipc/smoke/surfaces/etc. test is actually selected;
    # skip for pure-unit runs where -m explicitly excludes integration.
    markers = request.config.getoption("-m") or ""
    if markers and "unit" in markers and "ipc" not in markers and "smoke" not in markers:
        return

    def _factory():
        from gpd_tests.drivers.mcp import MCPClient
        return MCPClient()

    _check_build_skew(_factory)


def pytest_configure(config):
    """Guard against accidental parallel execution that would corrupt state."""
    if config.pluginmanager.hasplugin("xdist") and getattr(config.option, "dist", "no") != "no":
        raise pytest.UsageError(
            "This suite is single-instance only; pytest-xdist would corrupt state."
        )
    # Set GPD_APP_PATH to the debug build so harness_selftest can resolve it.
    if not os.environ.get("GPD_APP_PATH"):
        debug_app = (
            Path(__file__).parent.parent
            / "src-tauri" / "target" / "debug" / "bundle" / "macos" / "GPD Dev.app"
        )
        if debug_app.exists():
            os.environ["GPD_APP_PATH"] = str(debug_app)


def _auth_json_path() -> Path:
    """Return the opencode-cli auth.json path, honoring XDG_DATA_HOME.

    Mirrors the XDG-aware logic in ``scripts/reset.py`` and
    ``gpd_tests.pages.onboarding.sentinel_path``: respect ``XDG_DATA_HOME``
    when set, otherwise fall back to ``~/.local/share``. This keeps the
    session-seed fixture in lockstep with tier-3 reset paths.
    """
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "opencode" / "auth.json"


# Snapshot of auth.json bytes captured at session start. Kept in memory
# so the onboarding test's gpd_key fixture can still produce a key VALUE
# to type even after tier-3 reset has wiped the on-disk file.
#
# Note: auth.json lives in tier-3 (scripts/reset.py), not tier-2 — the
# credential is not "app state" that fresh_app tests want to wipe. Only
# the tier-3 onboarding test ever deletes it, so there's no need to
# restore to disk; the in-memory snapshot covers the one caller that
# still needs the value.
_AUTH_JSON_SNAPSHOT: bytes | None = None


def pytest_sessionstart(session):
    """Capture auth.json bytes so gpd_key has a fallback for tier-3 tests."""
    global _AUTH_JSON_SNAPSHOT
    auth_path = _auth_json_path()
    try:
        _AUTH_JSON_SNAPSHOT = auth_path.read_bytes()
    except FileNotFoundError:
        _AUTH_JSON_SNAPSHOT = None


# Current TOS version the product gates against
# (packages/app/src/components/tos-content.tsx:24). Keep in sync when
# the product bumps it; mismatch causes TosUpgradeGate to render a full-
# viewport block that hides every surface the tests rely on.
_TOS_VERSION = "1.0"
_TOS_STORAGE_KEY = "gpd.tos.acceptedVersion"


def _accept_tos_via_webview() -> None:
    """Set the TOS-accepted localStorage key so the gate doesn't render.

    The click-wrap TOS gate (welcome step 2 + TosUpgradeGate on version
    bump) checks ``localStorage[gpd.tos.acceptedVersion] === CURRENT_TOS_VERSION``.
    Setting this before a test runs keeps the gate from blocking surfaces,
    flows, and stress tests. localStorage lives in the WebKit data dir
    which tier-2 wipes, so this must be re-applied after every reset.

    Best-effort: swallows MCP failures so a stale socket / mid-launch
    webview never breaks a test's setup.
    """
    try:
        from gpd_tests.drivers.mcp import MCPClient, MCPError, MCPTimeout
    except Exception:
        return
    try:
        MCPClient(timeout_s=3.0).execute_js(
            f'localStorage.setItem("{_TOS_STORAGE_KEY}", "{_TOS_VERSION}")'
        )
    except (MCPError, MCPTimeout, FileNotFoundError, ConnectionRefusedError):
        pass
    except Exception:
        pass


@pytest.fixture
def gpd_key() -> str:
    """Return the GPD LiteLLM key from auth.json; fall back to snapshot; skip if absent.

    Falls back to the session-start snapshot (_AUTH_JSON_SNAPSHOT) so the
    onboarding test can still provide a key to type even when its
    clean_onboarding_state fixture has already deleted the on-disk copy.
    """
    import json as _json
    auth_path = _auth_json_path()
    key = ""
    try:
        data = _json.loads(auth_path.read_text())
        key = data.get("gpd", {}).get("key", "")
    except (FileNotFoundError, _json.JSONDecodeError):
        pass
    if not key and _AUTH_JSON_SNAPSHOT is not None:
        try:
            key = _json.loads(_AUTH_JSON_SNAPSHOT).get("gpd", {}).get("key", "")
        except _json.JSONDecodeError:
            pass
    if not key:
        pytest.skip(f"GPD key not found in {auth_path}; skipping real-backend test")
    return key


def _is_skipped(item) -> bool:
    """Return True if the item is unconditionally or conditionally skipped.

    Note on skipif: pytest accepts both boolean expressions and *string*
    expressions (e.g. ``@pytest.mark.skipif("sys.platform == 'darwin'", ...)``).
    A non-empty string is truthy but says nothing about whether the test will
    actually be skipped — only pytest can evaluate it in the test module's
    namespace. To avoid false positives (treating a truthy string literal as
    "skipped"), we bail out of the short-circuit for string skipif conditions
    and let pytest's own evaluator handle it. The consequence: a reset may run
    for a test pytest will ultimately skip, which is safe (just mildly wasteful)
    and strictly better than incorrectly suppressing a reset for a test that
    will actually run.
    """
    for m in item.iter_markers("skipif"):
        if not m.args:
            continue
        condition = m.args[0]
        if isinstance(condition, str):
            # String skipif: defer to pytest's evaluator, don't short-circuit.
            continue
        if condition:
            return True
    return bool(item.get_closest_marker("skip"))


@pytest.fixture(scope="session", autouse=True)
def seed_onboarding_state(request):
    """Seed auth.json + onboarding sentinel so GPD doesn't first-run.

    Opt in via two env vars together:
      GPD_TEST_SEED_ONBOARDING=1  AND  auth.json with {"gpd":{"type":"api","key":"<key>"}}

    The two-flag guard avoids accidentally clobbering a dev's real
    auth.json. When both are set, this fixture writes the key to the
    XDG-aware auth.json path (``$XDG_DATA_HOME/opencode/auth.json`` or
    ``~/.local/share/opencode/auth.json``) with mode 0o600 and ensures
    the XDG-aware onboarding sentinel (``$XDG_CONFIG_HOME/gpd/.gpd-initialized``
    or ``~/.config/gpd/.gpd-initialized``) exists, backing up and
    restoring both on teardown.
    """
    if os.environ.get("GPD_TEST_SEED_ONBOARDING") != "1":
        yield
        return
    # Read from auth.json (canonical source; env var fallback for CI)
    _auth = (Path(os.environ["XDG_DATA_HOME"])/"opencode"/"auth.json"
             if os.environ.get("XDG_DATA_HOME")
             else Path.home()/".local"/"share"/"opencode"/"auth.json")
    try:
        import json as _json
        key = _json.loads(_auth.read_text()).get("gpd", {}).get("key", "")
    except Exception:
        key = os.environ.get("GPD_API_KEY", "")
    if not key:
        yield
        return

    import json
    import shutil

    # Prefer the already-XDG-aware helper in onboarding.py over duplicating
    # logic; pair it with the local _auth_json_path() helper above.
    from gpd_tests.pages.onboarding import sentinel_path

    auth_path = _auth_json_path()
    _sentinel_path = sentinel_path()

    auth_path.parent.mkdir(parents=True, exist_ok=True)
    _sentinel_path.parent.mkdir(parents=True, exist_ok=True)

    auth_backup: Path | None = None
    created_auth = not auth_path.exists()
    created_sentinel = False
    # Hash of the content this fixture writes below. We use it on teardown
    # to confirm the file still contains exactly what we seeded before
    # deleting it — so if the user somehow edited auth.json during the
    # test, we leave their edits alone rather than clobbering them.
    seeded_blob = json.dumps({"gpd": {"type": "api", "key": key}}) + "\n"

    if auth_path.exists():
        auth_backup = auth_path.with_suffix(".json.bak-test-session")
        if auth_backup.exists():
            raise RuntimeError(
                f"Backup file already exists: {auth_backup}. "
                "A previous test session may not have cleaned up properly."
            )
        shutil.copy2(auth_path, auth_backup)

    def restore():
        # SAFETY rules:
        #   1. If we BACKED UP a pre-existing file, restore from backup.
        #      Never unlink unconditionally — a previous version had an
        #      `elif auth_path.exists(): auth_path.unlink()` branch that
        #      could wipe a real user key.
        #   2. If we CREATED the file (no pre-existing version), delete
        #      only if it still matches the seed we wrote. If the user
        #      or the product overwrote it during the test (unlikely but
        #      possible), leave their content.
        if auth_backup and auth_backup.exists():
            shutil.copy2(auth_backup, auth_path)
            auth_backup.unlink()
        elif created_auth and auth_path.exists():
            try:
                if auth_path.read_text() == seeded_blob:
                    auth_path.unlink()
            except OSError:
                # Read failed — leave file untouched rather than
                # guessing at its state.
                pass
        if created_sentinel and _sentinel_path.exists():
            _sentinel_path.unlink()

    # Register finalizer BEFORE writing, so teardown runs even if setup fails.
    request.addfinalizer(restore)

    auth_path.write_text(seeded_blob)
    auth_path.chmod(0o600)

    if not _sentinel_path.exists():
        _sentinel_path.write_text("seeded-by-tests-gui\n")
        created_sentinel = True

    yield


def _dismiss_native_dialogs() -> None:
    """Activate GPD and press Escape to close any open NSOpenPanel or native dialog.

    GPD can pop NSOpenPanel via the TCC re-grant flow (navigateToProject on
    a locked path). An open panel blocks GPD's event loop, causing MCP pings
    to time out. Activating GPD keeps the webview from being throttled by
    macOS; the Escape keypress closes any open panel without disrupting state.
    """
    import subprocess
    import time as _time
    from gpd_tests.pages.app_state import _APP_NAME

    # Bring GPD to the foreground so macOS does not throttle the webview.
    subprocess.run(
        ["osascript", "-e", f'tell application "{_APP_NAME}" to activate'],
        capture_output=True,
        check=False,
        timeout=5.0,
    )
    _time.sleep(0.2)
    # Press Escape to close any open native dialog.
    subprocess.run(
        ["osascript", "-e",
         'tell application "System Events" to key code 53'],
        capture_output=True,
        check=False,
        timeout=5.0,
    )
    _time.sleep(0.3)


@pytest.fixture(scope="session", autouse=True)
def _webview_server():
    """Serve the built frontend on http://localhost:1420 for the test session.

    The debug Tauri binary loads the webview from devUrl (http://localhost:1420)
    rather than embedded assets. This fixture starts a minimal static HTTP
    server on that port so the webview can load the frontend and register the
    tauri-plugin-mcp guest-js execute-js listener. Without it, execute_js
    always times out and the webview never responds.

    Skipped (server not started) if port 1420 is already bound — the developer
    already has their own dev server running and we should not compete with it.
    """
    import socket
    import threading
    import http.server

    dist_dir = Path(__file__).parent.parent / "dist"
    if not dist_dir.exists():
        # Dist not built — skip silently; tests that need execute_js will
        # still fail, but that's expected and not this fixture's fault.
        yield
        return

    # Check if something is already listening on 1420.
    sock_probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock_probe.settimeout(0.5)
    already_bound = sock_probe.connect_ex(("127.0.0.1", 1420)) == 0
    sock_probe.close()
    if already_bound:
        yield
        return

    class _SPAHandler(http.server.SimpleHTTPRequestHandler):
        """Serve static files; fall back to index.html for SPA routes."""

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(dist_dir), **kwargs)

        def log_message(self, *_args):
            pass  # silence request logging

        def do_GET(self):
            # Serve the file if it exists; otherwise serve index.html so the
            # SolidJS router can handle client-side navigation.
            path = dist_dir / self.path.lstrip("/").split("?")[0]
            if not path.exists() or path.is_dir():
                self.path = "/index.html"
            super().do_GET()

    server = http.server.HTTPServer(("127.0.0.1", 1420), _SPAHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield
    finally:
        server.shutdown()
        thread.join(timeout=5.0)


@pytest.fixture(scope="session")
def app_state(_webview_server):
    global _session_app_state
    from gpd_tests.pages.app_state import AppState

    state = AppState()
    _session_app_state = state
    # Cold-start mode: kill any stale GPD/opencode-cli before launching. Opt
    # in via PYTEST_COLD_START=1 so local interactive runs don't clobber the
    # user's live session.
    if os.environ.get("PYTEST_COLD_START") == "1":
        state.kill_stale()
    if not state.is_running():
        state.launch()
    state.wait_launched()
    # Dismiss any native dialog (NSOpenPanel from TCC unlock path) that can
    # block GPD's event loop and cause MCP pings to time out.
    _dismiss_native_dialogs()
    yield state
    if os.environ.get("PYTEST_QUIT_GPD") == "1":
        state.quit()


@pytest.fixture
def mcp(app_state):
    from gpd_tests.drivers.mcp import MCPClient, MCPError, MCPTimeout

    client = MCPClient()
    for _attempt in range(2):
        try:
            client.ping()
            break
        except (MCPTimeout, ConnectionRefusedError):
            if _attempt == 0:
                # NSOpenPanel or another native dialog may be blocking the
                # event loop. Dismiss it and retry once.
                _dismiss_native_dialogs()
                continue
            pytest.fail(
                "MCP ping timed out or connection refused after dialog dismissal — "
                "GPD event loop is unresponsive or MCP socket is stale. Relaunch GPD Dev."
            )
        except MCPError as e:
            msg = str(e).lower()
            if not ("auth" in msg or "token" in msg or "unauthoriz" in msg):
                raise
            from scripts.discover_mcp_token import discover as discover_token

            token = discover_token()
            if not token:
                pytest.fail(
                    f"MCP ping rejected as unauthenticated ({e}) and "
                    "scripts/discover_mcp_token found no token. Set "
                    "GPD_MCP_AUTH_TOKEN or drop a token at "
                    "~/Library/Application Support/inc.psi.gpd/mcp-auth.token."
                )
            client = MCPClient(auth_token=token)
            client.ping()
            break
    return client


@pytest.fixture
def ax(app_state):
    from gpd_tests.drivers.ax import AXClient

    return AXClient()


@pytest.fixture
def http(app_state):
    from gpd_tests.drivers.opencode_http import (
        HTTPClient,
        discover_sidecar_credentials,
        discover_sidecar_port,
    )

    def _sidecar_ready() -> bool:
        return app_state.sidecar_pid() is not None

    wait_until(_sidecar_ready, timeout_s=15.0)
    pid = app_state.sidecar_pid()
    assert pid is not None, "opencode-cli sidecar never appeared"
    port = discover_sidecar_port(pid=pid)
    user, pw = discover_sidecar_credentials(pid)
    client = HTTPClient(
        base_url=f"http://127.0.0.1:{port}",
        username=user,
        password=pw,
    )
    # MCP readiness != HTTP readiness: the sidecar can be listening on TCP
    # before /global/health wires up. Probe explicitly before handing the
    # client to tests.
    def _http_ready() -> bool:
        try:
            client.health()
            return True
        except Exception:
            return False

    if not wait_until(_http_ready, timeout_s=15.0):
        client.close()
        pytest.fail(
            f"opencode-cli sidecar at 127.0.0.1:{port} did not answer "
            "/global/health within 15s"
        )
    yield client
    client.close()


@pytest.fixture
def os_input():
    """Function-scoped OS input driver. Skipped if cliclick is missing."""
    try:
        from gpd_tests.drivers.os_input import OSInputClient
        client = OSInputClient()
    except Exception as e:
        pytest.skip(f"OSInputClient unavailable (cliclick missing?): {e}")
    return client


def _unregister_projects_matching(predicate) -> None:
    """Delete every GPD-registered project whose worktree matches predicate.

    A test that navigates the webview to /:dir/* triggers GPD's auto-register
    createEffect, which persists a project reference in the sidecar. When
    pytest subsequently cleans up the tmpdir, GPD's sidebar refresh hits
    the gone directory and surfaces a red toast ``Couldn't refresh <name>:
    error sending request for url (...)``. Teardown walks the sidecar's
    project list, matches against ``predicate(worktree: str) -> bool``,
    and DELETEs everything that matches.

    Best-effort: swallows every failure so a teardown can't mask the
    test's own assertion failure.
    """
    try:
        from gpd_tests.drivers.opencode_http import (
            HTTPClient,
            discover_sidecar_port,
            discover_sidecar_credentials,
        )
        from gpd_tests.pages.app_state import AppState
        pid = AppState().sidecar_pid()
        if pid is None:
            return
        port = discover_sidecar_port(pid=pid, timeout_s=3.0)
        user, pw = discover_sidecar_credentials(pid)
        client = HTTPClient(
            base_url=f"http://127.0.0.1:{port}",
            username=user,
            password=pw,
        )
        try:
            for proj in client.list_projects():
                proj_dir = proj.get("worktree") or proj.get("directory") or ""
                if predicate(proj_dir):
                    try:
                        client.delete_project(proj["id"])
                    except Exception:
                        pass
        finally:
            client.close()
    except Exception:
        pass


def _unregister_project_paths(target_paths: set[str]) -> None:
    """Back-compat wrapper: delete projects whose worktree exactly matches."""
    _unregister_projects_matching(lambda d: d in target_paths)


@pytest.fixture(autouse=True)
def _auto_unregister_tmpdir_projects(request, tmp_path_factory):
    """On every test teardown, unregister any GPD project rooted under the
    pytest tmpdir tree.

    Structural fix for the ``Couldn't refresh <tmpdir>: error sending
    request for url (...)`` toast: whenever a test registers a project
    by navigating the webview to ``/:dir/*``, pytest later wipes that
    directory but GPD keeps the reference. A teardown that walks the
    project list and DELETEs anything rooted under pytest's per-session
    tmpdir root catches every such registration — no per-fixture
    patching needed, and new tests are automatically covered.

    Checks both the direct path (``/var/folders/...``) and the resolved
    path (``/private/var/folders/...``) because macOS symlinks the former
    to the latter; the sidecar stores the resolved form.

    Tests marked @pytest.mark.harness_selftest opt out — those assert
    on raw project state and must not have teardown mutations.
    """
    yield
    if "harness_selftest" in {m.name for m in request.node.iter_markers()}:
        return
    try:
        base = tmp_path_factory.getbasetemp()
    except Exception:
        return
    roots = {str(base)}
    try:
        roots.add(str(base.resolve()))
    except Exception:
        pass
    # Path.is_relative_to would be cleaner but costs a Path conversion per
    # project; string-prefix matching with a trailing "/" is cheap and safe
    # because the sidecar always stores absolute directory paths.
    def _under_tmpdir(worktree: str) -> bool:
        if not worktree:
            return False
        return any(
            worktree == r or worktree.startswith(r + "/") for r in roots
        )
    _unregister_projects_matching(_under_tmpdir)


@pytest.fixture
def git_project_dir(tmp_path):
    """A tmp_path with a real git repo so the sidecar registers it as a project.

    Project cleanup is handled by the autouse
    ``_auto_unregister_tmpdir_projects`` fixture — any GPD project rooted
    under pytest's tmpdir gets DELETEd on teardown, so this fixture
    doesn't need its own unregister step.
    """
    import subprocess
    subprocess.run(["git", "init", str(tmp_path)], check=True, capture_output=True)
    # Set a repo-local identity so `git commit` works even on clean
    # machines and CI runners where global user.name / user.email aren't
    # configured. Without this, `git commit --allow-empty` below fails
    # with "Author identity unknown" and every test using this fixture
    # dies before reaching the app.
    subprocess.run(
        ["git", "-C", str(tmp_path), "config", "user.email", "tests-gui@gpd.local"],
        check=True, capture_output=True,
    )
    subprocess.run(
        ["git", "-C", str(tmp_path), "config", "user.name", "tests-gui"],
        check=True, capture_output=True,
    )
    subprocess.run(
        ["git", "-C", str(tmp_path), "commit", "--allow-empty", "-m", "init"],
        check=True, capture_output=True,
    )
    return tmp_path


# --- Per-test setup: foreground activation + marker-driven reset --------


def pytest_runtest_setup(item):
    """Activate GPD + honor tier/fresh_app resets before each test.

    Activation: macOS throttles backgrounded webviews, causing execute_js to
    time out. Bringing GPD to the foreground before each integration test
    keeps the JS bridge responsive without requiring manual window management.

    Reset: honors @pytest.mark.tier(n) / @pytest.mark.fresh_app to wipe and
    restart GPD at the requested tier before destructive tests.
    """
    if _is_skipped(item):
        return

    # Always re-seed the TOS-accepted key before a test runs. The product
    # gates the entire UI on localStorage[gpd.tos.acceptedVersion] ===
    # CURRENT_TOS_VERSION; if the key is missing, TosUpgradeGate renders a
    # full-viewport block that hides everything the test looks for. This
    # is a no-op if the key is already set. Skip for onboarding tests so
    # the welcome flow can still be exercised.
    if "clean_onboarding_state" not in getattr(item, "fixturenames", ()):
        _accept_tos_via_webview()

    # Activate GPD for any test that uses the MCP bridge.
    markers = {m.name for m in item.iter_markers()}
    if not markers.isdisjoint({"smoke", "surfaces", "ipc", "flows",
                                "regression", "broad", "lifecycle",
                                "explorer"}):
        try:
            import subprocess as _sp
            from gpd_tests.pages.app_state import _APP_NAME
            _sp.run(
                ["osascript", "-e",
                 f'tell application "{_APP_NAME}" to activate'],
                capture_output=True, check=False, timeout=3.0,
            )
        except Exception:
            pass  # best-effort; never block a test over an activate failure

    # Exit shell mode if active so model/agent/skills controls are visible.
    # Shell mode hides these controls (prompt-input.tsx:1554) and causes
    # surfaces tests to skip with "composer in shell mode?".
    if "surfaces" in markers:
        try:
            from gpd_tests.drivers.mcp import MCPClient
            _mcp_tmp = MCPClient(timeout_s=3.0)
            # Fast path: try to exit via the JS command system.
            _mcp_tmp.execute_js(
                '(() => { const cmd = window.__OPENCODE__?.commands?.get?.("prompt.mode.normal"); '
                'if (cmd) cmd.execute?.(); })()'
            )
            # Slow path: send Cmd+Shift+E if prompt-model is still absent,
            # which indicates the JS path didn't work (window.__OPENCODE__ not
            # exposed) or the app is genuinely in shell mode.
            import time as _time_b
            _time_b.sleep(0.05)
            _raw = str(_mcp_tmp.execute_js(
                '!!document.querySelector("[data-action=\\"prompt-model\\"]")'
            ) or "").strip().lower()
            in_shell = _raw in ("false", "null", "undefined", "nan", "0", "")
            if in_shell:
                from gpd_tests.pages.app_state import _APP_NAME
                import subprocess as _sp_b
                _sp_b.run(
                    ["osascript", "-e",
                     f'tell application "System Events" to tell process "{_APP_NAME}" '
                     'to key code 14 using {{command down, shift down}}'],
                    capture_output=True, check=False, timeout=3.0,
                )
                _time_b.sleep(0.1)
        except Exception:
            pass

    # Tier/fresh_app reset.

    tier_marker = item.get_closest_marker("tier")
    fresh = item.get_closest_marker("fresh_app") is not None
    tier: int | None = None
    if tier_marker is not None and tier_marker.args:
        tier = int(tier_marker.args[0])
    if fresh and tier is None:
        tier = 2
    if tier is None:
        return
    import scripts.reset as reset

    try:
        reset.run(tier=tier, dry_run=False, stop_app=True, start_app=True)
    except Exception as e:
        pytest.skip(f"GPD reset failed before test (tier={tier}): {e}")
    # Let the fresh app come up before the next fixture use. The driver
    # fixtures below are function-scoped so they rediscover socket path,
    # HTTP port, and creds on the next test.
    from gpd_tests.pages.app_state import AppState

    fresh_state = AppState()
    # Refresh the session-scoped app_state's _launched_pid BEFORE
    # wait_launched starts polling sidecar_pid(), so PPID disambiguation
    # uses the new PID rather than the pre-reset one.
    if _session_app_state is not None:
        _session_app_state.refresh_launched_pid()
    fresh_state.wait_launched(timeout_s=20.0)

    # Tier-2 wipes ~/Library/WebKit/<bundle>/ which holds localStorage, so
    # the TOS-accepted flag is gone. Re-seed it so the TosUpgradeGate
    # full-viewport block doesn't cover the surfaces the next test needs.
    # Skip for onboarding tests that want to exercise the welcome flow.
    if "clean_onboarding_state" not in getattr(item, "fixturenames", ()):
        _accept_tos_via_webview()


# --- Reporting hooks -----------------------------------------------------


def pytest_runtest_makereport(item, call):
    """Capture artifacts on test failure.

    In addition to screenshot/window capture, writes a triage hint markdown
    file listing product-code commits landed in the last 24h. Helps
    distinguish 'harness bug' from 'product regression' per the triage
    Gate-4 methodology. Silent no-op if scripts/triage_gate4.py is absent —
    this hook must not make other test failures harder to read.
    """
    if call.when != "call" or call.excinfo is None:
        return
    try:
        mcp_client = item.funcargs.get("mcp")
    except Exception:
        mcp_client = None
    module = item.nodeid.split("::")[0].replace("/", "_").replace(".py", "")
    test = item.name.replace("[", "_").replace("]", "")
    d = artifacts.artifact_dir(module, test)
    if mcp_client is not None:
        try:
            artifacts.save_bytes(
                d, "screenshot.jpg", mcp_client.take_screenshot_bytes()
            )
        except Exception as e:
            artifacts.save_text(d, "screenshot.err", str(e))
        try:
            artifacts.save_json(d, "windows.json", mcp_client.list_windows())
        except Exception as e:
            artifacts.save_text(d, "windows.err", str(e))
    artifacts.save_text(d, "nodeid.txt", item.nodeid + "\n")

    # Gate-4 triage hint: list product-code commits in the last 24h so a
    # failure's blast-radius is obvious at a glance.
    try:
        import datetime as _dt
        from pathlib import Path as _Path
        # Ensure the scripts/ dir is on sys.path. conftest.py's own location
        # lives alongside it, so this is normally fine.
        from scripts.triage_gate4 import find_related_commits  # type: ignore
    except ImportError:
        return

    now = _dt.datetime.now()
    yesterday = (now - _dt.timedelta(hours=24)).date().isoformat()
    try:
        commits = find_related_commits(
            since=yesterday,
            paths=[
                "packages/desktop/src-tauri/",
                "packages/desktop/src/",
            ],
        )
    except Exception:
        return

    triage_dir = _Path(__file__).parent / "artifacts" / "triage_hints"
    triage_dir.mkdir(parents=True, exist_ok=True)
    safe = item.nodeid.replace("/", "__").replace("::", "---").replace(" ", "_")
    hint = triage_dir / f"{safe}.md"
    lines = [
        f"# Triage hint for `{item.nodeid}`",
        "",
        f"Window: last 24h (since {yesterday} local).",
        "",
    ]
    if commits:
        lines.append(f"## Product-code commits that may be related ({len(commits)})")
        lines.append("")
        for c in commits:
            lines.append(f"- `{c['sha'][:8]}`  {c['subject']}")
    else:
        lines.append("_No product-code commits in the last 24h — harness-side issue is more likely._")
    hint.write_text("\n".join(lines) + "\n")


def pytest_report_header(config):
    slowmo = os.environ.get("PYTEST_SLOWMO_MS", "(default)")
    ci = os.environ.get("PYTEST_CI", "0")
    return [f"opencode-gpd-test | slow-mo={slowmo}ms | CI={ci}"]
