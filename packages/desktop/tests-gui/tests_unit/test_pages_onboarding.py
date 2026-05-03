"""Unit coverage for gpd_tests.pages.onboarding.

Exercises the module's helper (sentinel_path, sentinel_present) and the
Onboarding page object (welcome_visible, enter_api_key, wait_for_home) by
monkeypatching environment variables, the filesystem entry point, and the
internal DOMProbe so no live GPD or MCP bridge is required.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from gpd_tests.helpers.dom_probe import ProbeSkip
from gpd_tests.pages import onboarding as ob
from gpd_tests.pages.onboarding import Onboarding, sentinel_path


# ---------------------------------------------------------------------------
# sentinel_path
# ---------------------------------------------------------------------------


@pytest.mark.unit
def test_sentinel_path_uses_xdg_config_home_when_set(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    expected = tmp_path / "gpd" / ".gpd-initialized"
    assert sentinel_path() == expected


@pytest.mark.unit
def test_sentinel_path_falls_back_to_home_when_xdg_unset(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    fake_home = tmp_path / "homey"
    fake_home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))
    assert sentinel_path() == fake_home / ".config" / "gpd" / ".gpd-initialized"


@pytest.mark.unit
def test_sentinel_path_treats_empty_xdg_as_unset(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """An empty XDG_CONFIG_HOME is falsy — fall back to ~/.config."""
    monkeypatch.setenv("XDG_CONFIG_HOME", "")
    fake_home = tmp_path / "homey2"
    fake_home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))
    assert sentinel_path() == fake_home / ".config" / "gpd" / ".gpd-initialized"


# ---------------------------------------------------------------------------
# Onboarding.sentinel_present
# ---------------------------------------------------------------------------


@pytest.mark.unit
def test_sentinel_present_returns_true_when_file_exists(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    gpd_dir = tmp_path / "gpd"
    gpd_dir.mkdir()
    (gpd_dir / ".gpd-initialized").write_text("")
    assert Onboarding.sentinel_present() is True


@pytest.mark.unit
def test_sentinel_present_returns_false_when_file_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    # Nothing created under tmp_path/gpd — sentinel must be absent.
    assert Onboarding.sentinel_present() is False


# ---------------------------------------------------------------------------
# Onboarding.__init__ and welcome_visible
# ---------------------------------------------------------------------------


@pytest.mark.unit
def test_init_creates_dom_probe_bound_to_mcp() -> None:
    mcp = MagicMock()
    page = Onboarding(mcp)
    # _probe wraps _mcp — both are stored for later use.
    assert page._mcp is mcp
    assert page._probe is not None


@pytest.mark.unit
def test_welcome_visible_returns_true_when_probe_reports_true() -> None:
    mcp = MagicMock()
    page = Onboarding(mcp)
    page._probe = MagicMock()
    page._probe.eval_bool.return_value = True
    assert page.welcome_visible() is True
    # The probed expression must reference the welcome title text so drift
    # in the i18n constant is noticed.
    code = page._probe.eval_bool.call_args.args[0]
    assert "document.body.innerText.includes" in code


@pytest.mark.unit
def test_welcome_visible_returns_false_when_probe_reports_false() -> None:
    mcp = MagicMock()
    page = Onboarding(mcp)
    page._probe = MagicMock()
    page._probe.eval_bool.return_value = False
    assert page.welcome_visible() is False


@pytest.mark.unit
def test_welcome_visible_returns_false_on_probe_skip() -> None:
    mcp = MagicMock()
    page = Onboarding(mcp)
    page._probe = MagicMock()
    page._probe.eval_bool.side_effect = ProbeSkip("bridge flake")
    assert page.welcome_visible() is False


@pytest.mark.unit
def test_welcome_visible_escapes_double_quote_in_needle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If the i18n title ever contains a literal double-quote, the JS must
    escape it so the snippet stays syntactically valid."""
    # Patch the constant after import — module does `from ... import` inside
    # the method, so patch via the selectors module.
    from gpd_tests.helpers import selectors

    monkeypatch.setattr(selectors, "TEXT_WELCOME_TITLE", 'He said "hi"')
    mcp = MagicMock()
    page = Onboarding(mcp)
    page._probe = MagicMock()
    page._probe.eval_bool.return_value = True
    page.welcome_visible()
    code = page._probe.eval_bool.call_args.args[0]
    # Raw double-quotes around the injected needle would prematurely close
    # the JS string. Verify the quote was backslash-escaped.
    assert 'He said \\"hi\\"' in code


# ---------------------------------------------------------------------------
# Onboarding.enter_api_key
# ---------------------------------------------------------------------------


@pytest.mark.unit
def test_enter_api_key_happy_path_form_submitted() -> None:
    mcp = MagicMock()
    page = Onboarding(mcp)
    page._probe = MagicMock()
    page._probe.eval.return_value = ["form-submitted", "sk-abc"]
    page.enter_api_key("sk-abc")
    page._probe.eval.assert_called_once()
    # The JS must set the literal key into the input.
    js = page._probe.eval.call_args.args[0]
    assert "sk-abc" in js


@pytest.mark.unit
def test_enter_api_key_happy_path_button_clicked() -> None:
    mcp = MagicMock()
    page = Onboarding(mcp)
    page._probe = MagicMock()
    page._probe.eval.return_value = ["button-clicked", "sk-xyz"]
    page.enter_api_key("sk-xyz")  # must not raise


@pytest.mark.unit
def test_enter_api_key_raises_when_no_input_found() -> None:
    mcp = MagicMock()
    page = Onboarding(mcp)
    page._probe = MagicMock()
    page._probe.eval.return_value = ["no-input", ""]
    with pytest.raises(RuntimeError, match="welcome submit failed"):
        page.enter_api_key("sk-any")


@pytest.mark.unit
def test_enter_api_key_raises_when_no_submit_target() -> None:
    mcp = MagicMock()
    page = Onboarding(mcp)
    page._probe = MagicMock()
    page._probe.eval.return_value = ["no-submit-target", "sk"]
    with pytest.raises(RuntimeError, match="welcome submit failed"):
        page.enter_api_key("sk")


@pytest.mark.unit
def test_enter_api_key_raises_when_probe_returns_plain_string() -> None:
    """If the bridge returns a bare string (not the expected tuple), the
    method falls into the non-tuple branch and raises."""
    mcp = MagicMock()
    page = Onboarding(mcp)
    page._probe = MagicMock()
    page._probe.eval.return_value = "error"
    with pytest.raises(RuntimeError, match="welcome submit failed"):
        page.enter_api_key("sk")


@pytest.mark.unit
def test_enter_api_key_raises_when_actual_value_mismatches() -> None:
    mcp = MagicMock()
    page = Onboarding(mcp)
    page._probe = MagicMock()
    page._probe.eval.return_value = ["form-submitted", "wrong-value"]
    with pytest.raises(RuntimeError, match="input value mismatch"):
        page.enter_api_key("sk-expected")


@pytest.mark.unit
def test_enter_api_key_escapes_backslash_and_quote_in_key() -> None:
    mcp = MagicMock()
    page = Onboarding(mcp)
    page._probe = MagicMock()
    key = "sk-\\'danger'"
    page._probe.eval.return_value = ["form-submitted", key]
    page.enter_api_key(key)
    js = page._probe.eval.call_args.args[0]
    assert json.dumps(key) in js


# ---------------------------------------------------------------------------
# Onboarding.wait_for_home
# ---------------------------------------------------------------------------


@pytest.mark.unit
def test_wait_for_home_returns_when_sentinel_present_and_no_welcome(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Arrange: sentinel exists on disk, and welcome probe reports hidden.
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    gpd_dir = tmp_path / "gpd"
    gpd_dir.mkdir()
    (gpd_dir / ".gpd-initialized").write_text("")

    mcp = MagicMock()
    page = Onboarding(mcp)
    page._probe = MagicMock()
    page._probe.eval_bool.return_value = False  # welcome gone

    page.wait_for_home(timeout_s=1.0)  # must return without raising


@pytest.mark.unit
def test_wait_for_home_times_out_when_sentinel_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))

    mcp = MagicMock()
    page = Onboarding(mcp)
    page._probe = MagicMock()
    page._probe.eval_bool.return_value = True  # welcome still visible

    # Patch time.sleep so the polling loop does not block the test.
    monkeypatch.setattr(ob.time, "sleep", lambda *_a, **_kw: None)
    # Drive monotonic past the deadline on the second tick.
    ticks = iter([0.0, 0.05, 100.0])
    monkeypatch.setattr(ob.time, "monotonic", lambda: next(ticks))

    with pytest.raises(TimeoutError, match="welcome screen never transitioned"):
        page.wait_for_home(timeout_s=0.1)


@pytest.mark.unit
def test_wait_for_home_retries_until_sentinel_appears(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """First poll: sentinel absent. Second poll: sentinel created — returns."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    gpd_dir = tmp_path / "gpd"
    gpd_dir.mkdir()
    sentinel = gpd_dir / ".gpd-initialized"

    mcp = MagicMock()
    page = Onboarding(mcp)
    page._probe = MagicMock()
    page._probe.eval_bool.return_value = False  # welcome never visible

    sleep_calls: list[float] = []

    def fake_sleep(seconds: float) -> None:
        sleep_calls.append(seconds)
        # On first sleep, materialise the sentinel so the next loop exits.
        if len(sleep_calls) == 1:
            sentinel.write_text("")

    monkeypatch.setattr(ob.time, "sleep", fake_sleep)
    # Provide plenty of monotonic ticks under the deadline.
    ticks = iter([0.0, 0.01, 0.02, 0.03, 0.04])
    monkeypatch.setattr(ob.time, "monotonic", lambda: next(ticks))

    page.wait_for_home(timeout_s=5.0)
    # Must have slept exactly once before finding the sentinel.
    assert sleep_calls == [0.2]
