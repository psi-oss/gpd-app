# GPD Desktop App — Developer Cheatsheet

> **Scope note.** Concrete URLs, project UUIDs, and admin commands
> below reflect PSI-GPD's operational deployment. Downstream forks
> running their own GPD substitute their own Railway project, proxy
> URL, and API key identifiers.

## Quick Reference

### Key Paths
| What | Path |
|------|------|
| OpenCode fork | `~/Documents/psi/repos/gpd-opencode-fresh/` |
| GPD package | `~/Documents/psi/repos/get-physics-done/` |
| GPD config | `~/.config/gpd/` |
| GPD venv | `~/.config/gpd/.venv/` |
| GPD commands | `~/.config/gpd/command/` (69 files) |
| GPD agents | `~/.config/gpd/agents/` (24+ files) |
| Init marker | `~/.config/gpd/.gpd-initialized` |
| Config file | `~/.config/gpd/opencode.json` |
| uv binary (bundled) | `<app>/Contents/Resources/uv-bundle/uv` |
| App logs (prod) | `~/Library/Logs/inc.psi.gpd/` |
| App logs (dev) | `~/Library/Logs/inc.psi.gpd.dev/` |
| SQLite DB (dev) | `~/.local/share/opencode/opencode-gpd.db` |
| WebKit storage | `~/Library/WebKit/inc.psi.gpd*` |
| Tauri MCP socket | `$TMPDIR/tauri-mcp.sock` |

### Key Credentials

**Never commit secrets to this repo — it's public.** Retrieve them from Railway at runtime:

```bash
railway link --project 0ddad766-1ee1-44ed-95c2-f8f7d9cb5515
# Master key (admin access — mint/revoke virtual keys, admin UI login)
railway variables --service litellm --kv | grep ^LITELLM_MASTER_KEY=
# Admin UI username/password
railway variables --service litellm --kv | grep -E "^(UI_USERNAME|UI_PASSWORD)="
```

| What | Value |
|------|-------|
| LiteLLM URL | `https://litellm-production-46bb.up.railway.app` |
| LiteLLM admin UI | `https://litellm-production-46bb.up.railway.app/ui` |
| Test LiteLLM key | Mint one on-demand via `/key/generate` (see below) |
| Download page | `https://download.gpd.psi.inc` |
| Install script | `https://download.gpd.psi.inc/install` |

Mint a short-lived test key:
```bash
MASTER=$(railway variables --service litellm --kv | awk -F= '/^LITELLM_MASTER_KEY=/{print $2}')
curl -s -X POST 'https://litellm-production-46bb.up.railway.app/key/generate' \
  -H "Authorization: Bearer $MASTER" -H 'Content-Type: application/json' \
  -d '{"key_alias":"local-test","models":["gpd-chat"],"max_budget":50,"budget_duration":"7d"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['key'])"
```

### Repos
| Repo | Branch | Purpose |
|------|--------|---------|
| `psi-oss/gpd-app` | `gpd` (default) | OpenCode fork with GPD branding + uv setup |
| `psi-oss/gpd-app` | `gh-pages` | Download page + install script |
| `psi-oss/get-physics-done` | `main` | GPD Python package (not ours to modify) |
| `psi-oss/tauri-plugin-mcp` | `main` | Forked MCP plugin (Tauri ^2.9 compat) |

---

## Common Operations

### Wipe Everything (Clean Slate)
```bash
rm -rf ~/.config/gpd
rm -rf ~/Library/WebKit/inc.psi.gpd*
# Optionally reset the database too:
rm -f ~/.local/share/opencode/opencode-gpd.db
```

### Launch Dev Build
```bash
cd ~/Documents/psi/repos/gpd-opencode-fresh/packages/desktop
bun tauri dev
```

### Enable Tauri MCP (Optional — for Claude Code / Cursor webview automation)

The Rust plugin is already compiled into dev builds (gated by `#[cfg(debug_assertions)]` in `src-tauri/src/lib.rs`). The frontend JS bridge (`setupPluginListeners`) is gated behind `import.meta.env.DEV` and dynamically imports `tauri-plugin-mcp` — which is not in `packages/desktop/package.json` because the fork isn't published as an npm package yet. Without extra setup, dev builds log `tauri-plugin-mcp guest bridge not loaded: …` at startup and MCP `execute_js` / `query_page(map)` / etc. time out (only Rust-native tools like `take_screenshot` and `app_info` work).

To wire the JS bridge for local dev:

```bash
# One-time: clone + build the fork's guest-js package
mkdir -p ~/.local/share
git clone https://github.com/psi-oss/tauri-plugin-mcp.git ~/.local/share/tauri-plugin-mcp
cd ~/.local/share/tauri-plugin-mcp/mcp-server-ts && npm install && npm run build
cd ~/.local/share/tauri-plugin-mcp && npm install && npm run build

# Symlink the package into desktop/node_modules (not via package.json — keeps release clean)
ln -s ~/.local/share/tauri-plugin-mcp \
  ~/Documents/psi/repos/gpd-opencode-fresh/packages/desktop/node_modules/tauri-plugin-mcp

# Configure Claude Code / Cursor MCP client (create .mcp.json at repo root — gitignored):
cat > ~/Documents/psi/repos/gpd-opencode-fresh/.mcp.json <<'EOF'
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "node",
      "args": ["/Users/YOU/.local/share/tauri-plugin-mcp/mcp-server-ts/build/index.js"],
      "env": {
        "TAURI_MCP_IPC_PATH": "/var/folders/.../T/tauri-mcp.sock"
      }
    }
  }
}
EOF
```

Release safety is unaffected: Rust side compiles out via `debug_assertions`, JS side dead-code-eliminates the whole branch at Vite prod build time, and the dynamic `import()` is never resolved in prod. Zero attack surface in shipped binaries.

### Check First-Run Logs
```bash
# Latest log file
ls -t ~/Library/Logs/inc.psi.gpd*/*.log | head -1 | xargs cat

# Search for errors
ls -t ~/Library/Logs/inc.psi.gpd*/*.log | head -1 | xargs grep ERROR

# Search for setup steps
ls -t ~/Library/Logs/inc.psi.gpd*/*.log | head -1 | xargs grep "gpd_setup"
```

### Check Setup State
```bash
echo "=== Marker ===" && cat ~/.config/gpd/.gpd-initialized 2>&1
echo "=== Commands ===" && ls ~/.config/gpd/command/ | wc -l
echo "=== Agents ===" && ls ~/.config/gpd/agents/ | wc -l
echo "=== Venv Python ===" && ~/.config/gpd/.venv/bin/python --version
echo "=== GPD version ===" && ~/.config/gpd/.venv/bin/python -c "import gpd; print(getattr(gpd, '__version__', 'unknown'))"
echo "=== arxiv_mcp_server ===" && ~/.config/gpd/.venv/bin/python -c "import arxiv_mcp_server; print('OK')"
echo "=== Permission ===" && python3 -c "import json; d=json.load(open('$HOME/.config/gpd/opencode.json')); print(d.get('permission','NOT SET'))"
```

### Check MCP Config
```bash
python3 -c "
import json
d = json.load(open('$HOME/.config/gpd/opencode.json'))
mcp = d.get('mcp', {})
for name, cfg in sorted(mcp.items()):
    cmd = cfg.get('command', '?')
    print(f'{name}: {json.dumps(cmd)[:100]}')
"
```

### Check Database
```bash
# Projects
sqlite3 ~/.local/share/opencode/opencode-gpd.db "SELECT id, worktree FROM project"

# Sessions
sqlite3 ~/.local/share/opencode/opencode-gpd.db "SELECT id, directory, project_id FROM session ORDER BY time_created DESC LIMIT 10"
```

### Test LiteLLM Proxy
```bash
# Health check
curl -s https://litellm-production-46bb.up.railway.app/health/liveliness

# List models
curl -s https://litellm-production-46bb.up.railway.app/v1/models \
  -H "Authorization: Bearer $GPD_TEST_KEY" | python3 -m json.tool | grep '"id"'

# Send a test message
curl -s -X POST https://litellm-production-46bb.up.railway.app/v1/chat/completions \
  -H "Authorization: Bearer $GPD_TEST_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4-6", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 50}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])"

# Test Gemini with anyOf schema (tests sanitizeGemini fix at proxy level)
curl -s -X POST https://litellm-production-46bb.up.railway.app/v1/chat/completions \
  -H "Authorization: Bearer $GPD_TEST_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-flash-preview",
    "messages": [{"role": "user", "content": "hi"}],
    "tools": [{"type": "function", "function": {"name": "test", "description": "t", "parameters": {"type": "object", "properties": {"x": {"type": "string"}}, "anyOf": [{"required": ["x"]}]}}}]
  }' | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if 'choices' in d else d.get('error',{}).get('message','?')[:100])"
```

### Trigger Release Build
```bash
gh workflow run gpd-release.yml --repo psi-oss/gpd-app --ref gpd
# Monitor:
gh run list --repo psi-oss/gpd-app --workflow gpd-release.yml --limit 3
```

### Install from Release (Clean Test)
```bash
# Kill running app
pkill -f "GPD.app" 2>/dev/null

# Wipe state
rm -rf ~/.config/gpd ~/Library/WebKit/inc.psi.gpd*

# Download and install
cd /tmp && curl -sL -o GPD_aarch64.app.tar.gz \
  "https://github.com/psi-oss/gpd-app/releases/latest/download/GPD_aarch64.app.tar.gz" && \
  tar xzf GPD_aarch64.app.tar.gz && \
  rm -rf /Applications/GPD.app && \
  mv GPD.app /Applications/ && \
  /usr/bin/xattr -cr /Applications/GPD.app && \
  open /Applications/GPD.app
```

### Test CLI Install Script

Pipe form — non-interactive (skips key prompt; set the key via the desktop
app's welcome screen after install completes):
```bash
rm -rf ~/.gpd && curl -fsSL https://download.gpd.psi.inc/install | bash -s -- --skip-key
```

Or process-substitution if you want the interactive key prompt to work:
```bash
rm -rf ~/.gpd && bash <(curl -fsSL https://download.gpd.psi.inc/install)
```

### Update Download Page
```bash
cd /tmp && rm -rf gpd-gh-pages && \
  git clone --branch gh-pages --single-branch https://github.com/psi-oss/gpd-app.git gpd-gh-pages && \
  cd gpd-gh-pages && \
  # Edit files... then:
  git add -A && git commit -m "Update" && git push origin gh-pages
```

### Deploy LiteLLM Changes
```bash
cd /tmp/litellm-gpd  # or wherever your litellm config is
railway link --project 0ddad766-1ee1-44ed-95c2-f8f7d9cb5515 --service litellm --environment production
railway up --detach
```

---

## Architecture Overview

```
Professor's Machine
├── GPD Desktop App (Tauri)
│   ├── OpenCode sidecar (opencode-cli) — the AI agent runtime
│   ├── uv binary (bundled) — provisions Python on first run
│   └── OPENCODE_CONFIG_CONTENT env var → provider config + MCP server defs
│
├── ~/.config/gpd/
│   ├── .gpd-initialized — marker file (skip setup on subsequent launches)
│   ├── .venv/ — Python venv with get-physics-done[arxiv]
│   ├── command/ — 69 GPD slash commands (.md files)
│   ├── agents/ — 24+ GPD agent definitions (.md files)
│   └── opencode.json — provider config, MCP servers, permissions
│
└── All 8 MCP servers run locally via real Python:
    ├── conventions, errors, patterns, protocols, skills (reference/catalog)
    ├── state (project state CRUD — needs local filesystem)
    ├── verification (physics checks — complex schemas)
    └── arxiv (search/download papers — uses subprocess)

LiteLLM Proxy (Railway)
├── Routes API calls to Claude, GPT, Gemini
├── Per-user virtual keys with $2K/month budgets
├── Admin UI at /ui
└── Stock image (no custom callbacks)

GitHub (psi-oss/gpd-app)
├── gpd branch — OpenCode fork with all GPD changes
├── gh-pages branch — download page + install script
└── Releases — desktop app builds (draft → publish flow)
```

## Key Decisions & Why

| Decision | Why |
|----------|-----|
| uv instead of PyInstaller | Eliminates frozen binary bugs (sys.executable, preflight, missing commands) |
| Install from GitHub main (not PyPI) | PyPI 1.1.0 lacks --skip-readiness-check |
| `"permission": "allow"` | Professors shouldn't see permission prompts |
| sanitizeGemini extended | Strips anyOf+required and allOf+if/then for Gemini through LiteLLM |
| All MCP servers local | 4/8 need local filesystem; keeping all local is simpler for v1 |
| git required for projects | OpenCode needs git for diffs, snapshots, changes panel |
| UV_HTTP_TIMEOUT=120 | pywin32 on Windows timed out at default 30s |

## Known Issues

| Issue | Status | Workaround |
|-------|--------|------------|
| Non-git directories show as "/" | By design | OpenCode shows "Create Git repo" button in Review tab |
| Background agents not in OpenCode | Upstream issue, ~15 open PRs | Use parallel tool calls in single turn |
| Gemini schema errors through LiteLLM | Fixed in sanitizeGemini | Disable gpd-verification as fallback |
| First-run takes 15-60s | Expected | Install at install time (future) |
| Windows pywin32 timeout | Fixed (UV_HTTP_TIMEOUT=120) | Professor relaunches app |

## Stable Tag

```
git tag: gpd-stable-2026-04-17
```

Restore to known-good state: `git checkout gpd-stable-2026-04-17`
