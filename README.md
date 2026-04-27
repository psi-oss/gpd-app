# GPD — Get Physics Done

A physics research workspace by [PSI](https://psi.inc). Fork of [OpenCode](https://github.com/anomalyco/opencode).

---

## Install

```bash
# macOS / Linux
curl -fsSL https://download.gpd.psi.inc/install | bash
```

```powershell
# Windows 11 (non-admin PowerShell)
irm https://download.gpd.psi.inc/install.ps1 | iex
```

Each one-liner installs the GPD desktop app, the `gpd` CLI, an app-local
Python venv, LaTeX (`pdflatex` + `latexmk`), and `git` if missing — all
into `~/.gpd/` (or `%USERPROFILE%\.gpd` on Windows). No admin / `sudo`
required on Windows; the macOS / Linux one-liner uses `sudo` only when
installing system LaTeX or the Ubuntu `.deb`. The PSI access key gets
entered through the desktop app's welcome screen on first launch — no
install-time prompt needed.

Prefer to read before piping? See the verify-then-run flow in
[`install-gpd/README.md`](install-gpd/README.md#verify-the-installer-before-executing-optional-recommended)
or grab the desktop bundle directly from
[download.gpd.psi.inc](https://download.gpd.psi.inc).

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