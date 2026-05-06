# GPD — Get Physics Done

A physics research workspace by [PSI](https://psi.inc).

---

## Installation video 

https://github.com/user-attachments/assets/c112c72e-0018-4dce-9048-50cd1d296feb

https://github.com/user-attachments/assets/24e8d175-8f6d-41b5-92e0-56f6a3e8d1ee

## Tutorial

https://github.com/user-attachments/assets/b668acdc-adcd-430d-9462-1099d499056d

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
# macOS / Linux
curl -fsSL https://download.gpd.psi.inc/uninstall | bash -s -- --yes
```

```powershell
# Windows
irm https://download.gpd.psi.inc/uninstall.ps1 | iex
```

Flags, verify-before-piping, manual download: [`install-gpd/README.md`](install-gpd/README.md).

## For Users

Open the app, paste the access key you received, accept TOS/Privacy Policy, and open a research project in a folder of your choice to begin with GPD.

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
