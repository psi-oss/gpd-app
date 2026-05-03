from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

from gpd_tests.helpers import explorer
from gpd_tests.helpers.dom_probe import DOMProbe


@pytest.fixture(autouse=True)
def explorer_cleanup(mcp):
    yield
    try:
        explorer.dismiss(DOMProbe(mcp))
    except Exception:
        pass


@pytest.fixture
def explorer_project_dir(request) -> Path:
    """Persistent project under the artifact dir, not pytest's temp tree.

    The regular tmp_path fixtures are deleted while the app is still open,
    which can produce noisy "Couldn't refresh <tmpdir>" toasts after a run.
    Explorer projects live with the run artifacts so a human can inspect the
    exact project the app saw.
    """
    name = re.sub(r"[^a-zA-Z0-9_.-]+", "_", request.node.name)[:80]
    path = explorer.root() / "projects" / name
    path.mkdir(parents=True, exist_ok=True)
    if not (path / ".git").exists():
        subprocess.run(["git", "init", str(path)], check=True, capture_output=True)
        subprocess.run(
            ["git", "-C", str(path), "config", "user.email", "explorer@gpd.local"],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "-C", str(path), "config", "user.name", "gpd-explorer"],
            check=True,
            capture_output=True,
        )
        (path / "README.md").write_text("# GPD explorer project\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(path), "add", "README.md"], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(path), "commit", "-m", "init"], check=True, capture_output=True)
    return path.resolve()
