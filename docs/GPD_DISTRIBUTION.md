# GPD Distribution System — Complete Reference

> **Scope note.** Concrete URLs, project UUIDs, and admin commands
> below reflect PSI-GPD's operational deployment. Downstream forks
> running their own GPD substitute their own Railway project, proxy
> URL, and API key identifiers.

**Last updated:** April 16, 2026
**Status:** Production. Desktop and sidecar versions are decoupled — the release workflow accepts an explicit `version` input for desktop-only patches and always reports the bundled sidecar version in the release body. Latest shipped desktop build: `gpd-desktop-v1.1.2` (bundled sidecar: `get-physics-done 1.1.0`).

---

## Architecture

```
Professor's machine (macOS / Windows / Linux)
    │
    │  GPD Desktop App (rebranded OpenCode Tauri app)
    │  ├── OpenCode CLI sidecar (bundled, GPD-branded)
    │  ├── GPD PyInstaller sidecar (bundled, 8 MCP servers)
    │  ├── Provider config via OPENCODE_CONFIG_CONTENT env var
    │  └── Welcome screen → professor pastes LiteLLM virtual key
    │
    │  Authorization: Bearer <virtual-key>
    ▼
LiteLLM Proxy (Railway)
    │  URL: https://litellm-production-46bb.up.railway.app
    │  Validates virtual key, enforces $2K/month budget
    │  Filters /v1/models per key, translates tool calls
    ▼
Upstream Providers (PSI's API keys — never exposed)
    ├── Anthropic (Claude Opus/Sonnet 4.6, Haiku 4.5)
    ├── OpenAI (GPT-5.4/mini/nano/pro, GPT-5.3-codex, GPT-4.1/mini, o4-mini)
    └── Google (Gemini 3.1 Pro, 3 Flash, 3.1 Flash-Lite)
```

---

## Repositories

| Repo | Branch | What |
|------|--------|------|
| `psi-oss/gpd-app` | `gpd` (default) | OpenCode fork with GPD branding, welcome screen, provider config |
| `psi-oss/gpd-app` | `gh-pages` | Download page at `download.gpd.psi.inc` |
| `psi-oss/get-physics-done` | `main` | GPD Python package — MCP servers, commands, agents. **Version source for desktop app.** |

---

## Versioning

Desktop and sidecar versions are **decoupled** — the release workflow accepts an explicit `version` input for desktop-only patches, and always reports the bundled sidecar version in the release body. By default (no override), desktop follows `get-physics-done`.

| Source | Role | What it means |
|--------|------|---------------|
| `psi-oss/get-physics-done` pyproject.toml | Sidecar (default) | Read by the workflow's `resolve-version` step when no `version` input is given |
| PyPI `get-physics-done` | Sidecar (alt source) | Switch via `-f version_source=pypi` |
| Explicit `version` input | Desktop-only | Used as the desktop tag; sidecar version still resolved separately for the release body |

Full details: **`docs/RELEASING.md`**.

**Triggering a release:**
```bash
# Auto-detect version from GitHub (default) — creates/updates a DRAFT release
gh workflow run gpd-release.yml --repo psi-oss/gpd-app --ref gpd

# Publish the draft when ready
gh workflow run gpd-publish-draft.yml --repo psi-oss/gpd-app --ref gpd
```

All releases start as drafts; assets upload per-platform as each matrix job finishes. If the resolved tag collides with an already-published release, the version auto-increments as `<base>-1`, `<base>-2`, … so redrops against the same sidecar version don't overwrite published assets.

Full release playbook, including publishing, redrops, contaminated releases, and per-platform diagnostics: **see `docs/RELEASING.md`**.

When `github` is selected, the CI also installs `get-physics-done` directly from the GitHub repo main branch (not PyPI), so the sidecar binary contains the latest code.

---

## LiteLLM Proxy (Railway)

### Access
- **URL:** `https://litellm-production-46bb.up.railway.app`
- **Admin UI:** `https://litellm-production-46bb.up.railway.app/ui`
- **Admin login:** `UI_USERNAME` / `UI_PASSWORD` (set in Railway env vars)
- **Master key:** `LITELLM_MASTER_KEY` (in Railway env vars — starts with `sk-`)
- **Railway project:** `https://railway.com/project/0ddad766-1ee1-44ed-95c2-f8f7d9cb5515`

### Models (14 total)

| Provider | Model | LiteLLM model_name |
|----------|-------|--------------------|
| Anthropic | Claude Opus 4.6 | `claude-opus-4-6` |
| Anthropic | Claude Sonnet 4.6 | `claude-sonnet-4-6` |
| Anthropic | Claude Haiku 4.5 | `claude-haiku-4-5` |
| OpenAI | GPT-5.4 | `gpt-5.4` |
| OpenAI | GPT-5.4 mini | `gpt-5.4-mini` |
| OpenAI | GPT-5.4 nano | `gpt-5.4-nano` |
| OpenAI | GPT-5.4 Pro | `gpt-5.4-pro` |
| OpenAI | GPT-5.3 Codex | `gpt-5.3-codex` |
| OpenAI | GPT-4.1 | `gpt-4.1` |
| OpenAI | GPT-4.1 mini | `gpt-4.1-mini` |
| OpenAI | o4-mini | `o4-mini` |
| Google | Gemini 3.1 Pro | `gemini-3.1-pro-preview` |
| Google | Gemini 3 Flash | `gemini-3-flash-preview` |
| Google | Gemini 3.1 Flash-Lite | `gemini-3.1-flash-lite-preview` |

### Key Management

**Generate a key for a professor:**
```bash
curl -X POST 'https://litellm-production-46bb.up.railway.app/key/generate' \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "prof-smith",
    "key_alias": "prof-smith",
    "models": ["all-models"],
    "max_budget": 2000,
    "budget_duration": "30d"
  }'
```

**Revoke a key:**
```bash
curl -X POST 'https://litellm-production-46bb.up.railway.app/key/delete' \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -d '{"keys": ["sk-abc123..."]}'
```

**Check usage:**
```bash
curl 'https://litellm-production-46bb.up.railway.app/user/info?user_id=prof-smith' \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

### Adding a New Model

```bash
curl -X POST 'https://litellm-production-46bb.up.railway.app/model/new' \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model_name": "new-model-name",
    "litellm_params": {
      "model": "provider/model-id",
      "api_key": "os.environ/PROVIDER_API_KEY"
    },
    "model_info": {
      "access_groups": ["all-models"]
    }
  }'
```

Then add the model to `gpd_setup.rs:provider_config_json()` in the fork so the desktop app knows about it.

### Railway Environment Variables

| Variable | Purpose |
|----------|---------|
| `LITELLM_MASTER_KEY` | Admin auth for key management |
| `LITELLM_SALT_KEY` | DB encryption (immutable after first boot) |
| `UI_USERNAME` / `UI_PASSWORD` | Admin UI login |
| `ANTHROPIC_API_KEY` | Upstream Anthropic key |
| `OPENAI_API_KEY` | Upstream OpenAI key |
| `GOOGLE_API_KEY` | Upstream Google key |
| `STORE_MODEL_IN_DB` | `True` — manage models via API |
| `HOST` | `0.0.0.0` — required for Railway networking |
| `PORT` | `4000` |
| `LITELLM_NUM_RETRIES` | `3` |
| `LITELLM_REQUEST_TIMEOUT` | `120` |

---

## OpenCode Fork — What We Changed

### Branding (applies on every rebase)

| File | Change |
|------|--------|
| `packages/app/index.html` | Title → "GPD — Physics Research Workspace" |
| `packages/app/src/i18n/en.ts` | ~20 strings: "OpenCode" → "GPD", "Build anything" → "Get Physics Done" |
| `packages/app/src/i18n/*.ts` (16 files) | All non-English locales: "OpenCode" → "GPD" |
| `packages/desktop/index.html` | Same title |
| `packages/desktop/src/i18n/en.ts` | 6 desktop strings |
| `packages/desktop/src-tauri/tauri.conf.json` | productName "GPD Dev", identifier "inc.psi.gpd.dev", deep-link "gpd://" |
| `packages/desktop/src-tauri/tauri.beta.conf.json` | productName "GPD Beta" |
| `packages/desktop/src-tauri/tauri.prod.conf.json` | productName "GPD", disabled updater signing |
| `packages/ui/src/components/logo.tsx` | PSI Ψ SVG (Mark, Splash, Logo) |
| `packages/ui/src/components/favicon.tsx` | apple-mobile-web-app-title "GPD" |
| `packages/opencode/src/cli/logo.ts` | CLI block art "GPD" |
| `packages/opencode/src/cli/cmd/tui/app.tsx` | Terminal title "GPD" |
| `packages/desktop/src-tauri/icons/` | 159 icon files replaced with PSI Ψ |

### Welcome Screen + Auth Gate (GPD-specific code)

| File | What |
|------|------|
| `packages/app/src/components/welcome-screen.tsx` | New — PSI logo, key input, "Get Started" button |
| `packages/app/src/app.tsx` | `SetupGate` with localStorage gate, `__GPD_RESET_KEY__()` |
| `packages/app/src/pages/layout.tsx` | "Change GPD API Key" command palette entry |
| `packages/app/src/pages/layout/sidebar-shell.tsx` | Pencil icon button for key reset |

### Tauri First-Run Orchestration (GPD-specific code)

| File | What |
|------|------|
| `packages/desktop/src-tauri/src/gpd_setup.rs` | First-run detection, sidecar install, MCP merge, `provider_config_json()` |
| `packages/desktop/src-tauri/src/lib.rs` | Passes `OPENCODE_CONFIG_DIR` + `OPENCODE_CONFIG_CONTENT` to sidecar |
| `packages/desktop/src-tauri/src/cli.rs` | `extra_serve_env` parameter |
| `packages/desktop/src-tauri/src/server.rs` | `extra_env` parameter passthrough |
| `packages/desktop/src-tauri/tauri.conf.json` | `resources: ["gpd-sidecar-bundle/"]` |

### CI/CD

| File | What |
|------|------|
| `.github/workflows/gpd-release.yml` | Builds CLI + desktop (4 platforms) + GPD sidecar, creates release, updates download page |

### Scripts (in `scripts/gpd/`)

| File | What |
|------|------|
| `inject-litellm-provider.py` | Merges LiteLLM provider config into opencode.json (used by terminal install) |
| `sidecar_main.py` | PyInstaller entry point with `mcp-serve` and `list-servers` subcommands |
| `generate_pyinstaller_imports.py` | Auto-generates `--hidden-import` flags from `_BUILTIN_SERVERS` |

---

## How the Welcome Screen Works

1. `SetupGate` in `app.tsx` checks `localStorage.getItem("gpd.key.saved")`
2. If `null` → show `WelcomeScreen` component
3. Professor pastes LiteLLM virtual key → clicks "Get Started"
4. `auth.set({ providerID: "gpd", auth: { type: "api", key } })` writes to auth.json
5. `localStorage.setItem("gpd.key.saved", "true")` prevents future welcome screens
6. `global.dispose()` triggers re-bootstrap → provider connects → app loads

**Why it works:** The GPD provider definition is injected via `OPENCODE_CONFIG_CONTENT` env var when the OpenCode sidecar starts. This means `"gpd"` exists in OpenCode's provider database BEFORE the professor enters their key. When `auth.set` stores the key, the provider system finds the matching database entry and connects it.

**Config precedence (Decision 0.A, see `docs/CONFIG_ARCHITECTURE.md`):** the loader reads `~/.config/opencode/*` (OpenCode default base), then overlays `$OPENCODE_CONFIG_DIR/opencode.json` (GPD-managed, normally `~/.gpd/opencode.json`), then applies `OPENCODE_CONFIG_CONTENT` (env-tier defaults for managed fields only — MCP paths, `enabled_providers`, `permission`), then project-local `config.json`. The env-tier no longer includes `model`, so user model changes persist across restarts + venv repair via the `$OPENCODE_CONFIG_DIR` file. `inject_provider_config` guards against overwriting an existing model in that file on first-run and repair paths.

**Resetting the key:** Command palette (Cmd+K) → "Change GPD API Key", or pencil icon in sidebar. Both clear `localStorage("gpd.key.saved")` and reload.

**Important: Tauri WebView localStorage** persists in `~/Library/WebKit/inc.psi.gpd*/` (macOS). Deleting the `.app` does NOT clear it. Full wipe requires:
```bash
rm -rf ~/Library/WebKit/inc.psi.gpd*
rm -rf ~/Library/Application\ Support/inc.psi.gpd*
rm -rf ~/Library/Caches/inc.psi.gpd*
rm -rf ~/Library/Preferences/inc.psi.gpd*
rm -rf ~/.local/share/opencode/
rm -rf ~/.config/gpd/
```

---

## How to Rebase on a New OpenCode Release

Our changes are a single squashed commit on top of an upstream tag. Rebasing onto a new upstream version:

```bash
# 1. Fetch latest upstream tags
git fetch upstream --tags

# 2. Note the current base tag (e.g., v1.4.6) and the new target (e.g., v1.5.0)
# 3. Rebase our single commit onto the new tag
git checkout gpd
git rebase --onto v1.5.0 v1.4.6 gpd

# 4. Resolve any conflicts (usually just i18n/en.ts — new strings added upstream)

# 5. Force push to psi-oss
git push psi-oss gpd --force

# 6. Trigger release
gh workflow run gpd-release.yml --repo psi-oss/gpd-app --ref gpd
# Version auto-detected from get-physics-done. Override with: -f version=X.Y.Z
```

**Why this works:** We have ONE commit. `git rebase --onto <new-base> <old-base>` replays that single commit on the new tag. Conflicts are limited to files we actually modify.

**Highest conflict risk:** `packages/app/src/i18n/en.ts` (new strings added constantly). Our changes are isolated string replacements, so conflicts are usually trivial.

**After rebase:**
1. Run `cargo check` in `packages/desktop/src-tauri/` to verify Rust compiles
2. Trigger release: `gh workflow run gpd-release.yml --repo psi-oss/gpd-app --ref gpd -f version=<VERSION>`
3. Download page auto-updates

**Branch structure:**
- `gpd` (default) — our single squashed commit on top of an upstream tag. This is where we work.
- `dev` — tracks upstream's dev branch. We don't work here. Can sync via GitHub's "Sync fork" button.
- `gh-pages` — download page. Independent of the above.

---

## How to Add a New Model

1. **Add to LiteLLM** (immediate, no rebuild needed):
```bash
curl -X POST 'https://litellm-production-46bb.up.railway.app/model/new' \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model_name": "new-model", "litellm_params": {"model": "provider/model-id", "api_key": "os.environ/PROVIDER_KEY"}, "model_info": {"access_groups": ["all-models"]}}'
```

2. **Add to the fork's provider config** (requires rebuild):
   - Edit `packages/desktop/src-tauri/src/gpd_setup.rs` → `provider_config_json()`
   - Add the model to the JSON string with name, capabilities, and limits
   - Commit, push, trigger release

3. **Update `inject-litellm-provider.py`** (for terminal install path):
   - Add the model to the `PROVIDER_CONFIG` dict

---

## How to Add a New Provider (e.g., xAI, DeepSeek)

1. **Add upstream API key to Railway:**
   ```bash
   railway variables --set "XAI_API_KEY=xai-..."
   ```

2. **Add models to LiteLLM** (via API, see above)

3. **Update `gpd_setup.rs:provider_config_json()`** with the new models

4. **Rebuild and release**

---

## How to Generate Keys in Bulk

```bash
#!/bin/bash
LITELLM_URL="https://litellm-production-46bb.up.railway.app"

while IFS=, read -r user_id email; do
  key=$(curl -s -X POST "$LITELLM_URL/key/generate" \
    -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
    -H "Content-Type: application/json" \
    -d "{
      \"user_id\": \"$user_id\",
      \"key_alias\": \"$user_id\",
      \"models\": [\"all-models\"],
      \"max_budget\": 2000,
      \"budget_duration\": \"30d\"
    }" | python3 -c "import sys,json; print(json.load(sys.stdin)['key'])")
  echo "$user_id,$email,$key"
done < professors.csv > keys.csv
```

---

## CLI Install Script

**Shipped.** Hosted at `https://download.gpd.psi.inc/install` (no `.sh` suffix
— the URL maps to a script the gh-pages workflow republishes on every push to
`gpd` that touches `install-gpd/install`). SHA256 of the served bytes is
published alongside at `https://download.gpd.psi.inc/SHA256SUMS.txt`.

Recommended forms (from `install-gpd/README.md`):

```bash
# Interactive (handles the PSI key prompt + sudo password):
bash <(curl -fsSL https://download.gpd.psi.inc/install)

# Non-interactive — skip the install-time key prompt; key entered via
# the desktop app's welcome screen instead:
curl -fsSL https://download.gpd.psi.inc/install | bash -s -- --skip-key

# CI / fully scripted:
curl -fsSL https://download.gpd.psi.inc/install | GPD_API_KEY=sk-... bash
```

What it actually does today (single source of truth =
`install-gpd/install`; this list summarises):

1. **System dependencies** — git, LaTeX (BasicTeX on macOS, `texlive-*` on
   apt-based Linux), Python 3.11+ (or app-local PBS Python 3.13.3 on
   macOS / when system Python is missing). All idempotent — skipped if
   already present.
2. **GPD desktop app + CLI runtime** — Tauri bundle: `.deb` on
   Debian/Ubuntu, `.dmg` on macOS, NSIS `.exe` on Windows. Skipped if
   `/Applications/GPD.app` (or platform equivalent) already installed.
3. **Python venv** — `~/.gpd/venv/` with `get-physics-done@v1.1.0` from
   PyPI. Provides 8 MCP servers + `gpd` CLI.
4. **PSI key** — interactive prompt with TTY detection (the
   `[[ ! -t 0 ]]` guard at install:913 means non-TTY stdin warns +
   skips, doesn't hang). `GPD_API_KEY` env var preset path for CI.
5. **`gpd` wrapper** — `~/.gpd/bin/gpd` that re-resolves `GPD_HOME` at
   runtime via `${GPD_HOME:-$HOME/.gpd}`.
6. **PATH** — appends `~/.gpd/bin` to the user's shell rc, gated by
   `--no-modify-path` opt-out for users who want to wire their own.
7. **Runtime config** — `gpd install opencode --global` writes opencode
   agent + command definitions to `~/.config/opencode/`. Standard XDG
   path; opencode reads from there at runtime regardless of `GPD_HOME`.
8. **First-run marker** — `~/.gpd/.gpd-initialized` so the desktop app
   skips its own first-run setup.

For the canonical user-facing instructions + uninstall steps + flag
reference, see `install-gpd/README.md`. For the install logic itself,
read `install-gpd/install` directly — it's a self-contained ~1300-line
bash script.

### CLI vs Desktop comparison

The CLI install script and desktop app share the same Python venv +
get-physics-done package. Differences are in entry-point only:

| Surface | Desktop App | `gpd` CLI |
|---|---|---|
| Welcome / TOS gate | GUI dialog at first launch | n/a (CLI doesn't enforce TOS today; pilot users hit the GUI flow first) |
| `gpd` command | Wrapper at `~/.gpd/bin/gpd` | Same wrapper |
| MCP servers | Via bundled sidecar's venv | Via `~/.gpd/venv/bin/gpd-mcp-*` console scripts |
| Auto-update | `tauri-plugin-updater` | Manual `bash <(curl ...)` re-run |
| Gatekeeper/SmartScreen | First-launch quarantine strip via installer's `xattr -dr` | n/a (no app bundle) |

---

## Professor Onboarding Flow

1. Admin generates a virtual key for the professor
2. Send email: "Download GPD from download.gpd.psi.inc. Your API key: sk-abc123..."
3. Professor downloads DMG, installs, runs `/usr/bin/xattr -cr /Applications/GPD.app`
4. Opens GPD → welcome screen → pastes key → clicks "Get Started"
5. GPD opens with model picker showing Claude/GPT/Gemini
6. Professor types `/gpd-new-project` to start

---

## Ongoing Maintenance

| Task | Frequency | How |
|------|-----------|-----|
| Generate keys for new professors | As needed | `curl` to `/key/generate` |
| Revoke keys | As needed | `curl` to `/key/delete` |
| Monitor spend | Weekly | LiteLLM admin UI |
| Add new models | When providers release | LiteLLM API + `gpd_setup.rs` update |
| Rebase on new OpenCode | When upstream releases a new tag | See `docs/UPDATING.md` |
| Update LiteLLM | Monthly | Railway redeploy |
| Release new GPD desktop version | When `get-physics-done` updates | `gh workflow run gpd-release.yml --repo psi-oss/gpd-app --ref gpd` (auto-detects version) |

---

## Known Limitations

- **macOS Gatekeeper:** Unsigned app requires `xattr -cr` before first open. Include in email instructions.
- **Windows SmartScreen:** Similar unsigned warning. "Run Anyway" needed.
- **Auto-update:** Works — Tauri updater plugin is registered whenever CI has `TAURI_SIGNING_PRIVATE_KEY` (see `constants.rs:UPDATER_ENABLED`). `latest.json` is signed and promotes on normal semver bumps. Redrop `-N` suffixes do NOT promote (semver treats them as pre-releases); use a real patch bump for updates that need to reach existing installs.
- **MCP servers require PyInstaller sidecar:** If the sidecar isn't bundled (empty placeholder), MCP servers won't work. CI builds include it.
- **Code signing:** Not implemented. Would require Apple Developer Program ($99/year) + EV cert for Windows ($200-400/year). The ad-hoc signed bundle still works; the macOS TCC flow is handled explicitly (see below).

## macOS TCC (Track C)

GPD opens folders under `~/Documents`, `~/Desktop`, `~/Downloads`, which macOS TCC protects. Because the app is ad-hoc signed and doesn't declare `NS*UsageDescription` keys, the standard OS prompt doesn't fire. The flow we ship instead:

1. A Rust command `check_project_accessible` probes the folder from the Tauri main process. The probe is attributed to the signed app bundle (not the sidecar), so any later OS grant applies to GPD as a whole.
2. Cold-launch paths that would eagerly touch the folder (autoselect, `SyncProvider` bootstrap, session prefetch) gate on the probe. If `locked`, they skip the sidecar calls entirely — no EPERM storm.
3. The sidebar tile renders in a "locked" visual state (60% opacity, dashed border, tooltip "macOS is blocking access — click to reconnect").
4. Clicking the locked tile calls `projects.unlock`, which pops `NSOpenPanel` pre-navigated to the remembered worktree. User confirms → macOS records "inferred user intent" access → subsequent sidecar calls succeed.
5. The session grant propagates to the sidecar subprocess via TCC responsible-process attribution.

The flow is macOS-only; Linux/Windows go through the unchanged open path.

---

## File Locations on Professor's Machine

| Path | What |
|------|------|
| `/Applications/GPD.app` | The app |
| `~/.config/gpd/` | OpenCode config dir (MCP servers, commands, agents) |
| `~/.local/share/opencode/auth.json` | API key storage |
| `~/.local/share/opencode/opencode*.db` | Session database |
| `~/Library/WebKit/inc.psi.gpd/` | Tauri WebView data (localStorage) |
| `~/Library/Application Support/inc.psi.gpd/` | Tauri app settings |

---

## Troubleshooting

**"GPD is damaged and can't be opened"**
→ `xattr -cr /Applications/GPD.app`

**Welcome screen doesn't appear / stuck**
→ Wipe: `rm -rf ~/Library/WebKit/inc.psi.gpd* ~/.local/share/opencode/ ~/.config/gpd/`

**API calls fail after entering key**
→ Verify the key works: `curl -s https://litellm-production-46bb.up.railway.app/v1/models -H "Authorization: Bearer <key>"`

**Wrong key entered**
→ Command palette (Cmd+K) → "Change GPD API Key"

**Models not showing**
→ The `OPENCODE_CONFIG_CONTENT` env var defines available models. Check `gpd_setup.rs:provider_config_json()`.

**MCP servers not connected**
→ Check if GPD sidecar bundle exists in the app: `GPD.app/Contents/Resources/gpd-sidecar-bundle/gpd-sidecar`
