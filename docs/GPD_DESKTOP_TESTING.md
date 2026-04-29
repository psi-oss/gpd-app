# GPD Desktop App — Rigorous Testing Loop

> **Scope note.** Concrete URLs below reflect PSI-GPD's operational
> deployment. Downstream forks substitute their own proxy URL.

## Prerequisites
- `bun tauri dev` running from `packages/desktop/` in `gpd-opencode-fresh`
- Tauri MCP plugin connected (or alternative automation method)
- Fresh state: `rm -rf ~/.config/gpd ~/Library/WebKit/inc.psi.gpd*`
- LiteLLM key: set `$GPD_TEST_KEY` in your shell (mint one via `/key/generate` — see `docs/GPD_DESKTOP_CHEATSHEET.md`)
- LiteLLM proxy: `https://litellm-production-46bb.up.railway.app`

## Testing Tools Available

### Primary: Tauri MCP Plugin (if connected)
- Screenshot, click, type, inspect DOM, navigate via MCP tools
- Richest API — full DOM access, JavaScript execution
- Requires `bun tauri dev` with MCP plugin compiled in
- Socket at: `$TMPDIR/tauri-mcp.sock` (macOS: `/var/folders/.../T/tauri-mcp.sock`)
- Tools: `take_screenshot`, `query_page`, `click`, `type_text`, `execute_js`, `navigate`, `wait_for`, `mouse_action`, `manage_storage`, `manage_window`, `restart_app`
- Workflow: `query_page(mode='app_info')` → `query_page(mode='map')` for refs → `click`/`type_text` to interact

### Secondary: macOS Accessibility APIs (always available, no app modification)
- **Screenshots**: `screencapture -l <windowID> /tmp/screenshot.png`
  - Get window ID: `python3 -c "import Quartz; windows = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID); [print(w['kCGWindowNumber'], w.get('kCGWindowName','')) for w in windows if 'GPD' in str(w.get('kCGWindowOwnerName',''))]"`
- **Click buttons**: `osascript -e 'tell application "System Events" to tell process "GPD Dev" to click button "Name" of ...'`
- **Type text**: `osascript -e 'tell application "System Events" to tell process "GPD Dev" to keystroke "text"'`
- **Read UI text**: `osascript -e 'tell application "System Events" to tell process "GPD Dev" to get value of every static text of ...'`
- **Find elements**: `osascript -e 'tell application "System Events" to tell process "GPD Dev" to entire contents of window 1'`

### Backend: Direct API & Filesystem
- Sidecar API: curl against localhost port (found in app logs)
- SQLite database: `~/.local/share/opencode/opencode-gpd.db`
- App logs: `~/Library/Logs/inc.psi.gpd/`
- Filesystem: check `~/.config/gpd/` for installed commands/agents/config

### Strategy
Use MCP plugin as primary when available. Fall back to Accessibility APIs + screencapture when MCP is unavailable or for visual verification. Always verify backend state via filesystem/database/logs regardless of UI method.

---

## Iteration 1: First-Run Setup Verification

**Goal:** Verify the uv-based first-run setup completes successfully.

### Tests:
1. Wipe all GPD state: `rm -rf ~/.config/gpd`
2. Launch app via `bun tauri dev`
3. Verify log shows: "GPD first-run detected"
4. Verify uv finds or installs Python >= 3.11
5. Verify venv created at `~/.config/gpd/.venv/`
6. Verify `get-physics-done[arxiv]` installed: `~/.config/gpd/.venv/bin/python -c "import gpd; print(gpd.__version__)"`
7. Verify `gpd install opencode --global --skip-readiness-check` completed
8. Verify `~/.config/gpd/.gpd-initialized` exists
9. Verify `~/.config/gpd/command/` has 69 files
10. Verify `~/.config/gpd/agents/` has 24+ files
11. Verify `~/.config/gpd/opencode.json` has provider config with GPD models
12. Verify `~/.config/gpd/opencode.json` has `"permission": "allow"`
13. Verify log shows no ERROR lines during setup
14. Verify `arxiv_mcp_server` is importable: `~/.config/gpd/.venv/bin/python -c "import arxiv_mcp_server"`
15. Measure total setup time from logs (target: <30s with system Python, <60s without)

### Parallel agents:
- Agent A: Check filesystem state (commands, agents, config)
- Agent B: Check database state (projects, sessions)
- Agent C: Check sidecar logs for errors

---

## Iteration 2: Welcome Screen & API Key

**Goal:** Verify the welcome screen flow and API key persistence.

### Tests:
1. Wipe WebKit state: `rm -rf ~/Library/WebKit/inc.psi.gpd*`
2. Launch app — verify welcome screen appears (screenshot)
3. Verify PSI Ψ logo is displayed (not OpenCode logo)
4. Verify "Get Physics Done" text is shown (not "Build anything")
5. Enter your test key (`$GPD_TEST_KEY` — mint via `/key/generate`)
6. Click "Get Started"
7. Verify main IDE appears (not welcome screen)
8. Verify provider "GPD (PSI)" is visible in settings
9. Verify models are listed (Claude, GPT, Gemini)
10. Close and relaunch — verify welcome screen does NOT appear (localStorage gate)
11. Test key reset: Settings → Account → Change API Key
12. Verify welcome screen reappears after key reset
13. Test malformed key entry (no "sk-" prefix) — verify error handling

---

## Iteration 3: MCP Servers (All 8)

**Goal:** Verify all 8 MCP servers connect and respond.

### Tests:
For each MCP server, verify:
1. **gpd-conventions** — green dot, `convention_check` tool responds
2. **gpd-errors** — green dot, `get_error_class` tool responds
3. **gpd-patterns** — green dot, `lookup_pattern` tool responds
4. **gpd-protocols** — green dot, `get_protocol` tool responds
5. **gpd-skills** — green dot, `list_skills` tool responds
6. **gpd-state** — green dot, `get_state` tool responds (requires git project)
7. **gpd-verification** — green dot, `run_check` tool responds
8. **gpd-arxiv** — green dot, `search_papers` tool responds (requires network)

### Also verify:
9. MCP server commands point to venv Python (not sidecar binary): check `opencode.json` mcp entries
10. `sys.executable` in MCP servers is real Python: `~/.config/gpd/.venv/bin/python -c "import sys; print(sys.executable)"`
11. arxiv bridge subprocess works: `~/.config/gpd/.venv/bin/python -m gpd.mcp.servers.arxiv_bridge` (should start without "No such option: -m" error)
12. Toggling a server off/on in settings works

### Verification method:
- Screenshot MCP settings page → count green dots
- Send messages that trigger each MCP tool
- Check sidecar logs for MCP errors

### Parallel agents:
- Agent A: Test conventions, errors, patterns, protocols
- Agent B: Test skills, state, verification
- Agent C: Test arxiv (search, download, read, download_source)

---

## Iteration 4: GPD Commands (All 69)

**Goal:** Verify all `/gpd-*` slash commands are installed and autocomplete.

### Tests:
1. Type `/gpd-` in chat input — verify autocomplete shows commands
2. Count total commands shown (expected: 69)
3. Test key commands:
   - `/gpd-new-project` — creates a new project structure
   - `/gpd-help` — shows help
   - `/gpd-status` — shows project status
   - `/gpd-suggest` — suggests next action
   - `/gpd-doctor` — runs health check
   - `/gpd-conventions` — manages conventions
   - `/gpd-verify` — runs verification
   - `/gpd-new-milestone` — creates milestone
   - `/gpd-plan-phase` — plans a phase
   - `/gpd-execute-phase` — executes a phase
4. Verify each command at minimum loads without error
5. Check `~/.config/gpd/command/` file count matches
6. Verify command names use hyphens (gpd-new-project), NOT colons (gpd:new-project)

### Parallel agents:
- Agent A: Test project lifecycle commands (new-project, new-milestone, plan-phase, execute-phase)
- Agent B: Test utility commands (help, status, suggest, doctor)
- Agent C: Test verification/convention commands

---

## Iteration 5: Model Selection & Provider

**Goal:** Verify all models work through LiteLLM.

### Tests (send "hi" to each model):
1. **claude-sonnet-4-6** — verify response
2. **claude-opus-4-6** — verify response
3. **claude-haiku-4-5** — verify response
4. **gpt-5.4** — verify response
5. **gpt-5.4-mini** — verify response
6. **gpt-4.1** — verify response
7. **o4-mini** — verify response (reasoning model)
8. **gemini-3-flash-preview** — verify response (tests sanitizeGemini fix)
9. **gemini-3.1-pro-preview** — verify response
10. **gemini-3.1-flash-lite-preview** — verify response

### For each model verify:
- Response received (not error)
- Model name shown in UI matches selection
- No schema validation errors (especially Gemini with all 8 MCP servers enabled)
- Tool calls work (send "list my files" to test bash tool)

### Budget: ~$50 max across all models

### Parallel agents:
- Agent A: Test Claude models (3)
- Agent B: Test GPT models (4)
- Agent C: Test Gemini models (3) — critical for sanitizeGemini fix

---

## Iteration 6: File Operations & Editor

**Goal:** Verify file creation, editing, reading, and display in the editor.

### Prerequisites: Open a git-initialized project

### Tests:
1. Ask agent to create a Python file — verify it appears in file tree
2. Ask agent to create a LaTeX file — verify it appears
3. Ask agent to create and run a Python script that generates a PNG — verify image loads in editor
4. Click on a .py file in git changes — verify code displays (not blank)
5. Click on a .png file in git changes — verify image displays (not "Unable to load image")
6. Ask agent to edit an existing file — verify diff shows in review panel
7. Ask agent to read a file — verify it can read contents
8. Test with different file types: .py, .tex, .md, .json, .yaml, .txt
9. Verify git changes panel shows correct count
10. Verify "0 Changes" / "No uncommitted changes" correctly reflects state

### Parallel agents:
- Agent A: Test file creation and display
- Agent B: Test file editing and diffs
- Agent C: Test image/binary file handling

---

## Iteration 7: Python Script Execution

**Goal:** Verify the agent can write and execute Python scripts with scientific packages.

### Tests:
1. Ask: "Write and run a Python script that plots sin(x) from 0 to 2pi" — verify matplotlib works
2. Ask: "Calculate the eigenvalues of a 3x3 random matrix using numpy" — verify numpy works
3. Ask: "Solve the differential equation dy/dx = -y with scipy" — verify scipy works
4. Ask: "Simplify the expression (x^2 - 1)/(x - 1) using sympy" — verify sympy works
5. Verify Python path resolves to the GPD venv: agent runs `which python3` → should be `~/.config/gpd/.venv/bin/python`
6. Verify pip is available for on-demand package installs
7. Test a script that writes output to a file — verify file appears in project

### Parallel agents:
- Agent A: Test numpy + matplotlib (plotting)
- Agent B: Test scipy + sympy (computation)
- Agent C: Test file I/O and package management

---

## Iteration 8: Session Management

**Goal:** Verify session creation, switching, and project handling.

### Tests:
1. Create a new session — verify it appears in sidebar
2. Switch between sessions — verify chat history is preserved
3. Create a session in a new project directory
4. Verify project is discovered (check database)
5. Test session title auto-generation
6. Test session forking (if available)
7. Test multiple projects open simultaneously
8. Verify non-git directory shows "Create a Git repository" button
9. Verify agent's CWD matches the project directory (ask "what's my current working directory?")
10. Verify files created by agent are in the correct project directory

---

## Iteration 9: Permission System

**Goal:** Verify `"permission": "allow"` works — no permission prompts.

### Tests:
1. Verify `opencode.json` has `"permission": "allow"`
2. Ask agent to run a bash command — should NOT show permission prompt
3. Ask agent to read a file outside project — should NOT show permission prompt
4. Ask agent to write a file — should NOT show permission prompt
5. Ask agent to make a web request — should NOT show permission prompt
6. Reset permissions to default — verify prompts reappear
7. Re-set to "allow" — verify prompts stop

---

## Iteration 10: Branding & Localization

**Goal:** Verify GPD branding is consistent everywhere.

### Tests:
1. Title bar shows "GPD" (not "OpenCode")
2. Welcome screen shows PSI Ψ logo
3. Welcome screen says "Get Physics Done" (not "Build anything")
4. Settings show "GPD (PSI)" as provider name
5. CLI logo in terminal (if accessible) shows "GPD"
6. Switch to each non-English locale — verify no "OpenCode" text appears
7. About/Help section shows GPD branding
8. Deep link protocol uses `gpd://` (not `opencode://`)

---

## Iteration 11: GPD New-Project End-to-End

**Goal:** Verify the core professor workflow — create a new physics project.

### Tests:
1. Open a new empty directory
2. Click "Create a Git repository" if prompted
3. Run `/gpd-new-project`
4. Answer the project creation questions (provide a simple physics topic)
5. Verify PROJECT.md is created
6. Verify .gpd/ directory structure exists
7. Verify state.json is initialized
8. Run `/gpd-suggest` — verify it suggests next steps
9. Run `/gpd-health` — verify it passes
10. Verify conventions are initialized

---

## Iteration 12: arxiv End-to-End

**Goal:** Test the full arxiv research workflow.

### Tests:
1. Ask: "Search arxiv for recent papers on quantum error correction"
2. Verify `search_papers` MCP tool is called and returns results
3. Ask: "Download paper 2404.10035"
4. Verify `download_paper` MCP tool works
5. Ask: "Read the downloaded paper"
6. Verify `read_paper` MCP tool returns paper content
7. Ask: "Download the source archive for 2404.10035"
8. Verify `download_source` MCP tool works (this was the sys.executable bug)
9. Verify downloaded files exist on disk
10. Ask the agent to summarize the paper — verify it uses the content

---

## Iteration 13: Settings & Configuration

**Goal:** Verify all settings work correctly.

### Tests:
1. Open Settings (gear icon)
2. **General tab:**
   - Change theme — verify it applies
   - Change font size — verify it applies
   - Check Account section — "Change API Key" button exists
3. **Shortcuts tab:**
   - Verify keybinds are listed
4. **Providers tab:**
   - Verify GPD provider is listed and connected
   - Verify no other providers show (only GPD)
5. **Models tab:**
   - Verify all 16 models are listed
   - Change default model — verify it sticks across sessions
6. **MCP servers:**
   - Verify all 8 servers listed
   - Toggle a server off/on — verify it disconnects/reconnects

---

## Iteration 14: Edge Cases & Error Recovery

**Goal:** Verify the app handles edge cases gracefully.

### Tests:
1. **Network failure:** Disconnect WiFi → send a message → verify error shown (not crash)
2. **Large file:** Ask agent to create a 10MB file → verify no crash
3. **Concurrent sessions:** Open 3 sessions rapidly → verify all work
4. **App restart:** Close and reopen → verify state is preserved
5. **Stale venv:** Delete `~/.config/gpd/.venv/` → relaunch → verify first-run retries
6. **Corrupt config:** Corrupt `opencode.json` → relaunch → verify recovery
7. **Long-running task:** Start a task that takes >30s → verify it completes
8. **Unicode:** Send a message with unicode/emoji → verify rendering
9. **Empty project:** Open an empty directory → verify app doesn't crash
10. **Multiple app instances:** Try launching twice → verify single-instance handling
11. **Wrong API key:** Enter invalid key → verify clear error message
12. **Expired/rate-limited key:** Verify graceful handling of 429 responses

---

## Iteration 15: Production Build Comparison

**Goal:** Verify the production release build matches dev behavior.

### Tests:
1. Download latest `.tar.gz` from GitHub releases
2. Install to `/Applications/GPD.app`
3. Wipe state and do fresh install
4. Run iterations 1-3 against the production build
5. Compare: MCP server count, command count, model list, setup time
6. Verify auto-update check runs on launch (check logs)
7. Verify the app identifier is `inc.psi.gpd` (not `inc.psi.gpd.dev`)

---

## Iteration 16: Final Branding & Professor-Friendliness Sweep

**Goal:** Ensure zero "OpenCode" references and zero coding jargon in anything a professor can see.

### CRITICAL MANDATE
This app is for **physics professors who may not be familiar with code**. Every piece of user-facing text must make sense to them. "OpenCode" must NEVER appear in anything a professor can see — it should always say "GPD". Avoid coding jargon in user-facing text.

### Branding replacements:
- "OpenCode" → "GPD" everywhere user-visible
- "Build anything" → "Get Physics Done"
- "CLI binary" → "application"
- "Sidecar" → never show to users
- "Repository" → "project" or "project folder"
- "opencode.json" in error messages → "configuration file" or "GPD settings"
- Links to opencode.ai → GPD support URLs or remove
- Theme named "OpenCode" → "GPD"
- Web manifest "OpenCode" → "GPD"

### Launch 10 parallel agents:
1. **Desktop i18n** — All `packages/desktop/src/i18n/*.ts` files: replace "OpenCode" → "GPD"
2. **App i18n** — All `packages/app/src/i18n/*.ts` files: replace "OpenCode", coding jargon
3. **UI components** — `packages/ui/src/`: themes, manifests, schema names
4. **HTML & config** — All `*.html`, user-facing `*.json`
5. **Rust source** — `packages/desktop/src-tauri/src/*.rs`: user-visible strings
6. **Git/coding jargon audit** — All i18n/component text for: "git", "commit", "push", "repository", "CLI", "binary", "sidecar", "runtime", "terminal"
7. **Welcome screen & onboarding** — `welcome-screen.tsx`, `app.tsx`: verify GPD branding
8. **Settings & menus** — Settings pages, menu items, command palette for "OpenCode"
9. **Error messages** — All error/warning strings: make professor-friendly
10. **Visual verification** — Tauri MCP screenshots of every screen: scan for "OpenCode"

### Also fix during ANY iteration:
If you discover a branding issue or coding-jargon issue during any iteration (1-15), fix it immediately. Do not defer to Iteration 16. Log the fix in CHANGES.md.

---

## Discovery Iterations

If any iteration above discovers undocumented features or new bugs:
- Add them to a new Iteration 17+ below
- Re-run affected iterations after fixes
- Document all findings in a TESTING_RESULTS.md file

---

## Logging Requirements

### CHANGES.md
After every iteration, append a summary of all changes made:
- What was broken and why
- What was fixed and how
- Files modified (with paths)
- Commits created (if any)
- Before/after behavior

Format:
```
## Iteration N: [Name]
**Date:** YYYY-MM-DD
**Changes:**
- [file] — description of change
**Bugs fixed:**
- [description] — root cause → fix
**Rebuilds triggered:** yes/no
```

### INTERESTING_FINDINGS.md
Log anything noteworthy that doesn't merit a code change yet:
- Surprising behavior that might be a bug but needs more investigation
- Performance observations (e.g., "MCP server X takes 3s to connect while others take <1s")
- UX rough edges that professors might struggle with
- Undocumented features discovered
- Potential improvements for future iterations
- Edge cases that work but feel fragile
- Differences between dev build and production build behavior

Format:
```
## [Category]: [Brief title]
**Found in:** Iteration N
**Severity:** Low/Medium/High
**Description:** What was observed
**Why interesting:** Why it matters
**Action:** None yet / Investigate later / File upstream issue
```

---

## Execution Instructions

For each iteration:
1. Launch multiple parallel agents (one per test group)
2. Each agent runs its tests and reports: PASS/FAIL + evidence
3. For any FAIL: immediately debug with additional agents
4. After fixing, re-run the failed test to confirm
5. Move to next iteration only when current iteration is 100% PASS
6. If `bun tauri dev` needs restart, kill and relaunch
7. Save all test results to `TESTING_RESULTS.md`
8. Append changes to `CHANGES.md` after every fix
9. Append observations to `INTERESTING_FINDINGS.md` throughout
10. Both files live in `docs/` alongside this file
