"""Selftests for the source-level BRD surface manifest."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.extract_surface_manifest import build_manifest


FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "gpd_tests"
    / "fixtures"
    / "surface_manifest.json"
)


@pytest.mark.unit
@pytest.mark.harness_selftest
def test_surface_manifest_fixture_is_fresh():
    expected = json.loads(FIXTURE.read_text())
    assert build_manifest() == expected, (
        "surface_manifest.json is stale. Refresh with:\n"
        "  cd packages/desktop/tests-gui && "
        "uv run python scripts/extract_surface_manifest.py > "
        "gpd_tests/fixtures/surface_manifest.json"
    )


@pytest.mark.unit
@pytest.mark.harness_selftest
def test_surface_manifest_has_parallelizable_slices():
    manifest = json.loads(FIXTURE.read_text())
    surfaces = manifest["surfaces"]
    total_surfaces = sum(len(items) for items in surfaces.values())
    actions = manifest["actions"]

    assert len(actions) >= 20, "expected at least 20 static data-action controls"
    assert total_surfaces >= 80, "expected enough source surfaces for broad sharding"
    assert surfaces["dialogs"], "dialog surfaces missing from manifest"
    assert surfaces["settings"], "settings surfaces missing from manifest"
    assert surfaces["promptInput"], "prompt-input surfaces missing from manifest"
    assert surfaces["fileEditor"], "file-editor surfaces missing from manifest"
    assert surfaces["session"], "session surfaces missing from manifest"
