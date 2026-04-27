# GPD — Get Physics Done

A physics research workspace by [PSI](https://psi.inc). Fork of [OpenCode](https://github.com/anomalyco/opencode).

---

## Install

```bash
# macOS / Linux
curl -fsSL https://download.gpd.psi.inc/install | bash
```

```powershell
# Windows
irm https://download.gpd.psi.inc/install.ps1 | iex
```

## Uninstall

```bash
# macOS
curl -fsSL https://download.gpd.psi.inc/uninstall | bash -s -- --yes
```

```bash
# Linux
curl -fsSL https://download.gpd.psi.inc/uninstall.sh | bash -s -- --yes
```

```powershell
# Windows
irm https://download.gpd.psi.inc/uninstall.ps1 | iex
```

Removes `~/.gpd/`, the desktop app, PATH entries, and the `gpd` entry
from opencode's `auth.json`. Keeps system-wide deps (git, LaTeX, brew)
since other apps may use them — uninstaller prints copy-pasteable
removal commands at the end.

Flags, verify-before-piping, manual download: [`install-gpd/README.md`](install-gpd/README.md).

## For professors / post-docs

Open the app, paste the access key you received, start a research project. That's it.

## For developers

- Release playbook: [`docs/RELEASING.md`](docs/RELEASING.md)
- Rebase onto a new upstream OpenCode tag: [`docs/UPDATING.md`](docs/UPDATING.md)
- Architecture + LiteLLM + macOS TCC notes: [`docs/GPD_DISTRIBUTION.md`](docs/GPD_DISTRIBUTION.md)
- Local dev cheatsheet: [`docs/GPD_DESKTOP_CHEATSHEET.md`](docs/GPD_DESKTOP_CHEATSHEET.md)

```bash
bun install
cd packages/desktop && bun tauri dev
```

## License

Upstream OpenCode license applies. See [`LICENSE`](LICENSE).