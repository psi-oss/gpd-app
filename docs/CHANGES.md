# GPD Desktop App — Changes Log

## Remove `gpt-5.5-pro` and `gpt-5.4-pro` from picker + bootstrap config (2026-05-08)

**Date:** 2026-05-08
**Changes:**
- `packages/opencode/src/provider/gpd-models.ts`: dropped both pro entries from `GPD_MODEL_METADATA`, `GPD_MODEL_REASONING_EFFORTS`, and `GPD_RESPONSES_API_MODELS`. Added both ids to `GPD_MODEL_HIDDEN_IDS` so the resolver short-circuits if the LiteLLM proxy still advertises them in `/v1/models` while the `gpd-chat` access group is being purged on Railway.
- `packages/desktop/src-tauri/src/gpd_setup.rs`: removed both pro models from the embedded fallback config (the inline `format!` JSON and the `serde_json::json!` block); updated the bundled-config integration test from 16 → 14 models and dropped the pro ids from the assertion array.
- `packages/opencode/test/provider/gpd-models.test.ts`: inverted the previous "metadata stays present" test into a "stays removed" guard so a future regression fails loudly.
- `packages/app/src/context/local.test.ts`: swapped pro fixture ids for `gpt-5.5` / `gpt-5.4`.
- `packages/opencode/script/gpd-full-payload-probe.ts`, `.github/workflows/gpd-model-payload-probe.yml`: default model lists no longer include the pro variants.
- `packages/opencode/src/provider/transform.ts`, `packages/ui/src/components/session-turn.tsx`: comment text mentioning pro variants reworded.
- `docs/GPD_DISTRIBUTION.md`: model count 16 → 14, table rows removed, removal-rationale callout added.
**Why:**
Trace review of 2026-05-07/08 sessions found `gpt-5.5-pro(xhigh)` accounted for 87% of LiteLLM spend ($1,867 of $2,151 over 14 days) at a 0% prompt-cache hit rate, while non-pro variants ran 92–97% cache-hit on the same task families. The pro tier is also implicated in two empty-terminator failures on Ning Bao's bootstrap session (5/7 + 5/8 — sessB confirmed as a 401 because his key allow-list lacked `gpt-5.5-pro`, but the picker offered it anyway via stale `/v1/models` cache). Removing the variants from the picker eliminates both the cost lever and the failure surface in one move.
**Out-of-scope (server-side cleanup tracked separately):**
- The LiteLLM proxy DB rows for `gpt-5.5-pro` and `gpt-5.4-pro` in the `all-models` and `gpd-chat` access groups still need to be deleted via `/model/delete` (with master key) so `/v1/models` stops advertising them. The `GPD_MODEL_HIDDEN_IDS` shield protects desktop users until that lands.
- Active session resumes that hardcoded `gpt-5.5-pro` (e.g. Sergio's mid-flight phase plans) will need a model-id remap on resume; planner artifacts that pinned the pro id should be re-pointed at `gpt-5.5`.

## Sidecar Watchdog in Release + Native Windows ARM64 Bundle (2026-04-29)

**Date:** 2026-04-29
**Changes:**
- `packages/desktop/src-tauri/src/lib.rs`: sidecar watchdog now runs in release builds (was debug-only). Reuses a stable port + basic-auth password across respawns so the webview's cached HTTP client stays valid — no event-channel push to the frontend needed. Adds a 10-respawn / 5-min sliding-window rate cap, 10-consecutive-failure hard cap, and a 60s timeout on each post-respawn health check (so a half-alive sidecar that accepts TCP but never responds can't wedge the watchdog forever). Env builder is now a closure rebuilt per respawn so future config-driven env values aren't frozen at boot.
- `.github/workflows/gpd-release.yml`: added `aarch64-pc-windows-msvc` to the release matrix, cross-compiled from `windows-latest`. Pinned the matching `uv` SHA256 (542b318c...). Tauri produces `GPD_<ver>_arm64-setup.exe`.
- `install-gpd/windows_11/install_main.ps1`: ARM64 hosts now prefer the native `_arm64-setup.exe`, with graceful fallback to `_x64-setup.exe` if the native bundle hasn't been published yet.
- `docs/RELEASING.md`: documented the new ARM64 installer artifact.
**Bug fixed:**
- bun under Windows' x86-on-ARM emulator hit the OS' RADAR_PRE_LEAK_64 memory-leak detector mid-session, exiting `opencode-cli.exe` and leaving the GUI stuck on "Could not reach This computer" until manual relaunch (Application event-log id 1001, P1 opencode-cli.exe v1.3.11.0; reproduced on Parallels Win 11 ARM, 2026-04-29). Native ARM64 build avoids the emulator. Watchdog is defense-in-depth so any future sidecar death is auto-recovered without a stuck UI.
**Out-of-scope (tracked separately):**
- Watchdog still polls `is_alive()` every 500ms — switching to a wait()-based exit signal would need the Tauri sidecar plugin to expose a wait future.
- Orphan-child reaping when bun crashes (LSPs / Python / MCP servers reparent to PID 1). Needs Windows Job Objects + Linux PR_SET_CHILD_SUBREAPER.

## Tauri Native Modal Guard (2026-04-29)

**Date:** 2026-04-29
**Changes:**
- Replaced revoke-consent `window.confirm` / `window.alert` with app-rendered inline confirmation UI.
- Replaced dependency-installer `window.confirm` with app-rendered inline confirmation UI.
- Added `scripts/check-app-static.sh` and `.github/workflows/app-static-gates.yml` to block `window.alert`, `window.confirm`, and `window.prompt` in app/desktop UI code on PRs and pushes.
**Bug fixed:**
- macOS WebKit could wedge a native confirm dialog opened from inside the settings modal; both OK and Cancel appeared unresponsive.

## GPT 5.5 Pro Model Enablement (2026-04-29)

**Date:** 2026-04-29
**Changes:**
- Added `gpt-5.5-pro` to GPD provider metadata, desktop fallback config, distribution docs, and release test expectations.
- Added the production LiteLLM DB model row for `gpt-5.5-pro` in the `all-models` and `gpd-chat` access groups.
- Set the GPD reasoning-effort picker to `medium`, `high`, and `xhigh`; direct OpenAI probe rejects `low` for this model.
- Overrode production LiteLLM pricing for this row because the pinned `v1.83.14.rc.1` cost map has stale GPT 5.5 Pro prices.

## GPD Home Path Unification + LiteLLM Pin Bump (2026-04-27)

**Date:** 2026-04-27
**Changes:**
- Unified GPD home directory across platforms: `~/.gpd/` on Linux/macOS, `%USERPROFILE%\.gpd\` on Windows. Legacy `~/.config/gpd/` location removed.
- Canonical managed venv now lives at `~/.gpd/venv/` (no leading dot). Earlier paths `~/.gpd/.venv/` and `~/.config/gpd/.venv/` are historical only.
- Sidecar launched with `OPENCODE_CONFIG_DIR=~/.gpd` (see `packages/desktop/src-tauri/src/lib.rs`); `inject_provider_config` writes MCP entries pointing at `~/.gpd/venv/bin/python`.
- `infra/litellm/Dockerfile` LiteLLM pin bumped from `v1.83.7-stable` → `v1.83.14.rc.1` (deployed to Railway 2026-04-27, commit `b0de8c0f1b`). Picks up `gpt-5.5` model registry entry and `_is_claude_4_7_model` reasoning-effort branch — both missing in 1.83.7 caused HTTP 400 on opus-4-7 reasoning and `gpt-5.5` `tool_choice`. RC base image is Chainguard Wolfi without runtime `pip`/`uv`, so the Dockerfile now COPYs `uv` from `ghcr.io/astral-sh/uv:0.11.7` to install `asyncpg` into LiteLLM's bundled venv.
**Bugs fixed:**
- Two GPD homes (`~/.gpd/` and `~/.config/gpd/`) on Linux drifted apart — venv lived in one, opencode.json in the other, MCP server paths picked the wrong one. Single home eliminates the split.
- `claude-opus-4-7` reasoning calls returned HTTP 400 from LiteLLM 1.83.7 (`_map_reasoning_effort` lacked the 4.7 branch). Fixed by pin bump.
- `gpt-5.5` requests returned HTTP 400 (`openai does not support parameters: ['tool_choice']`) — 1.83.7's registry had no entry, fell through to gpt-5 base path's `tool_choice` strip. Fixed by pin bump.
**Rebuilds triggered:** yes (Rust path changes + Docker image redeploy)

## PR-Review Root-Cause Fix Batch (2026-04-22)

**Date:** 2026-04-22
**Context:** 13 PRs (#10-#23) authored by @amorari reviewed via three passes
(prior reviewer, parallel Claude deep-review, Codex adversarial). 12 of 13
observations re-landed as root-cause fixes at the correct architectural
layer; 1 (sidecar supervisor refactor) deferred pending production crash
telemetry. Full review at `docs/PR-REVIEW-2026-04-22.md`; fix plan at
`docs/PR-FIX-PLAN-2026-04-22.md`.

**Commits (17 on gpd since 388a4c87a0):**
- `71b0fc52d9` — `Config.updateGlobal` now awaits `invalidate(true)`; `update` taps errors before dying
- `33bb17a455` — markdown + deps Rust tests covering the real XSS / dangerous-URL surface
- `a021309667` — Decision 0.A: `OPENCODE_CONFIG_DIR` promoted to first-class global tier
- `ef31cb34a8` — Decision 0.B: hybrid ARIA-first + `data-testid` registry
- `a61b29e5a0` — Decision 0.C: single sidecar supervisor task (design only; implementation deferred)
- `492b5ec675` — installer drops default login-profile `GPD_API_KEY` export; `--export-key` opt-in
- `20efc24ba4` — SDK + middleware workspace/directory routing on all HTTP methods
- `618c48cb9d` — DELETE /session SSE routes by session.directory + orphan-workspace emits `session.deleted`
- `5fbc28980d` — path canonicalization helpers (`canonicalize_project_path` Tauri command + `canonicalizeAndReject`)
- `9c52508bc6` — service-layer NotFoundError throws for permission/question/revert (404 via middleware)
- `c52b3d23f4` — typed selector registry at `packages/app/src/testing/selectors.ts` + CI uniqueness check
- `0bbb10eb72` — workspace key canonicalization at child-store boundaries + SSE event routing
- `d1945f9cfc` — `loadGlobal` reads `$OPENCODE_CONFIG_DIR`; `inject_provider_config` preserves user model
- `5c63233f6f` — `waitForPaint` visibility-gated + 500ms safety ceiling (stops hidden-window boot hang)
- `3d13a13651` — session deep-link parser with `gpd://`/`opencode://` scheme allowlist + batch-last helper
- `80f7aaadb9` — CodeMirror `contentDOM` testid attachment (not the empty shell div)
- `db2d53a6cd` — **Task 1.5a: gpd-logger graceful-shutdown flush** (see below)

## Task 1.5a: GPD logger graceful-shutdown flush

**Date:** 2026-04-22
**Supersedes:** Task 1.5 (full Rust sidecar supervisor — deferred).

**Changes:**
- `packages/opencode/src/sink/http-writer.ts` — `GpdLogHttp.post` gains optional `{ signal?: AbortSignal }` threaded into `fetch`. AbortError routes to existing network-catch → spill.
- `packages/opencode/src/sink/gpd-logger.ts` — new `drainState(cache)` materialises pending per-session queues and POSTs in bounded parallel (concurrency 8); 1500ms budget via `OPENCODE_GPD_SHUTDOWN_TIMEOUT_MS`. Extends `Effect.addFinalizer` to drain before `Scope.close`. Adds `drainPending` to the `Interface` for in-command callers.
- `packages/opencode/src/index.ts` — SIGTERM (Unix only) / SIGINT handlers call `AppRuntime.dispose()` under a 2s hard wall-clock.
- `packages/opencode/test/sink/http-writer-abort.test.ts` — 3 tests locking AbortSignal wiring: happy-path `{ kind: "ok" }`, mid-flight abort → spill in <1s, pre-aborted signal → immediate spill.

**Bugs fixed:**
- 1s-debounce in-memory queue silently dropped on process exit (documented at `docs/LOGGING.md:28`) — root cause: no SIGTERM handler + finalizer cleared state without flushing. Graceful exit now drains to LiteLLM or disk.

**Deferred:** full Rust sidecar supervisor — 10-agent adversarial review concluded the refactor is ~600-800 LOC against a failure mode we have no telemetry for, while the flush handler alone captures the only concrete user-facing value. Rust-side SIGTERM-to-sidecar still TODO; will land with the supervisor when production crash data justifies it.

**Rebuilds triggered:** no (TypeScript-only)

## Pre-Iteration: Immediate Branding Fixes
**Date:** 2026-04-17
**Changes:**
- `packages/desktop/src-tauri/src/windows.rs:56` — Changed `.title("OpenCode")` → `.title("GPD")` (window title bar)
- `packages/desktop/src-tauri/release/appstream.metainfo.xml:8,9,17` — Changed name "OpenCode" → "GPD", summary to "AI-powered physics research workspace", description to physics-oriented text
- `packages/ui/src/assets/favicon/site.webmanifest:2,3` — Changed name/short_name "OpenCode" → "GPD"
**Bugs fixed:**
- Window title showed "OpenCode" instead of "GPD" — root cause: hardcoded string in windows.rs → fixed to "GPD"
- AppStream metadata identified app as "OpenCode" coding agent — fixed to GPD physics workspace
- Web manifest PWA name was "OpenCode" — fixed to "GPD"
**Rebuilds triggered:** yes (Rust change in windows.rs requires `bun tauri dev` restart)

## Proactive Branding Sweep (while app down)
**Date:** 2026-04-17
**Changes:**
- `packages/desktop/src/i18n/ja.ts` — 5 "OpenCode" → "GPD" replacements (Japanese)
- `packages/desktop/src/i18n/ko.ts` — 5 "OpenCode" → "GPD" replacements (Korean)
- `packages/desktop/src/i18n/pl.ts` — 5 "OpenCode" → "GPD" replacements (Polish)
- `packages/desktop/src/i18n/no.ts` — 5 "OpenCode" → "GPD" replacements (Norwegian); "CLI-binærfil" → "GPD-applikasjonen"
- `packages/desktop/src/i18n/ru.ts` — 5 "OpenCode" → "GPD" replacements (Russian)
- `packages/desktop/src/i18n/fr.ts` — 5 "OpenCode" → "GPD" replacements (French); "d'OpenCode" → "de GPD"; "CLI" → "application"
- `packages/desktop/src/i18n/zht.ts` — 5 "OpenCode" → "GPD" replacements (Traditional Chinese)
- `packages/desktop/src/i18n/zh.ts` — 5 "OpenCode" → "GPD" replacements (Simplified Chinese)
- `packages/desktop/src/i18n/bs.ts` — 5 "OpenCode" → "GPD" replacements (Bosnian); "OpenCode-a" → "GPD-a"
- `packages/desktop/src/i18n/br.ts` — 5 "OpenCode" → "GPD" replacements (Brazilian Portuguese)
- `packages/desktop/src/i18n/es.ts` — 5 "OpenCode" → "GPD" replacements (Spanish)
- `packages/desktop/src/i18n/ar.ts` — 5 "OpenCode" → "GPD" replacements (Arabic)
- `packages/desktop/src/i18n/da.ts` — 5 "OpenCode" → "GPD" replacements (Danish)
- `packages/desktop/src/i18n/de.ts` — 5 "OpenCode" → "GPD" replacements (German); "CLI-Binary" → "GPD-Anwendung"
- `packages/ui/src/theme/context.tsx:69` — Theme display name "OpenCode" → "GPD"
- `packages/ui/src/theme/desktop-theme.schema.json` — Title/description "OpenCode" → "GPD"
- `packages/ui/src/theme/themes/opencode.json` — Theme name "OpenCode" → "GPD"
- `packages/app/src/pages/error.tsx:304` — Feedback URL opencode.ai → github.com/psi-oss/gpd-app/issues
- `packages/app/src/pages/layout.tsx:2358` — Feedback URL opencode.ai → github.com/psi-oss/gpd-app/issues
**Bugs fixed:**
- 70 "OpenCode" references across 14 non-English locale files → all replaced with "GPD" with proper grammar in each language
- "CLI binary" jargon in sidecarMissing error → replaced with "application"/"aplicación"/"Anwendung"/etc in each language
- Theme picker showed "OpenCode" → now shows "GPD"
- Error/feedback links pointed to opencode.ai → now point to GPD GitHub issues
- Theme schema referenced "OpenCode Desktop Theme" → now says "GPD Desktop Theme"
**Rebuilds triggered:** no (TypeScript/JSON changes, hot-reloaded by Vite)

## Proactive Branding Sweep Part 2 (while app down)
**Date:** 2026-04-17
**Changes:**
- 17 app i18n files (`packages/app/src/i18n/*.ts`) — replaced "opencode.json" with localized "GPD settings" in 2 keys each:
  - `dialog.plugins.empty`: "configured in opencode.json" → "configured in GPD settings" (17 languages)
  - `error.chain.checkConfig`: "Check your config (opencode.json)" → "Check your GPD settings" (17 languages)
  - Includes en, ja, ko, pl, no, ru, es, zht, de, bs, ar, zh, da, fr, br, th, tr
**Bugs fixed:**
- 34 "opencode.json" references in user-facing error messages across 17 locale files → replaced with "GPD settings" in each language
- Removed technical `(opencode.json)` parenthetical from error messages — professors don't need to know config file names
**Rebuilds triggered:** no

## Iteration 3: MCP Server Python Path Fix
**Date:** 2026-04-17
**Changes:**
- `packages/desktop/src-tauri/src/gpd_setup.rs` — `inject_provider_config()` now overwrites MCP server entries with the correct venv Python path (`~/.config/gpd/.venv/bin/python`). Previously, `gpd install opencode` wrote MCP entries pointing to a stale `~/.gpd/venv/` which lacked the `arxiv_bridge` module.
- `~/.config/gpd/opencode.json` (runtime fix) — updated all 8 MCP server Python paths from `~/.gpd/venv/bin/python` → `~/.config/gpd/.venv/bin/python`
**Bugs fixed:**
- gpd-arxiv MCP server failed to start — root cause: `gpd install opencode` used `hook_python_interpreter()` which picked `~/.gpd/venv/` (older venv without arxiv_bridge), while the correct venv at `~/.config/gpd/.venv/` had the module. Fix: `inject_provider_config()` now always overwrites MCP paths with the managed venv.
**Rebuilds triggered:** yes (Rust change, but runtime config also fixed immediately)

## Iteration 7: Scientific Packages Fix
**Date:** 2026-04-17
**Changes:**
- Runtime: `uv pip install numpy scipy matplotlib sympy` into `~/.config/gpd/.venv/` (immediate fix)
- `packages/desktop/src-tauri/src/gpd_setup.rs` — Added scientific packages install step in `ensure_gpd_installed()` after GPD package. Installs numpy, scipy, matplotlib, sympy. Made non-fatal (warns but doesn't block startup if it fails).
**Bugs fixed:**
- GPD venv missing scientific packages — fixed by installing numpy/scipy/matplotlib/sympy into current venv via uv.
- Revised approach: instead of pre-installing packages globally, make `uv` available to the agent so it can create per-project venvs on demand.
**Rebuilds triggered:** yes

## Iteration 7 (revised): Per-project venv support via uv
**Date:** 2026-04-17
**Changes:**
- `packages/desktop/src-tauri/src/gpd_setup.rs` — Replaced global scientific package install with uv symlink into `~/.config/gpd/bin/`. Agent can now run `uv venv && uv pip install numpy` per-project.
- `packages/desktop/src-tauri/src/lib.rs` — Prepend `~/.config/gpd/bin/` and `~/.config/gpd/.venv/bin/` to sidecar PATH so agent can find `uv` and GPD Python.
- Runtime: created `~/.config/gpd/bin/uv` symlink to bundled uv binary.
**Bugs fixed:**
- Agent couldn't install packages on demand — uv wasn't on PATH. Now `uv` is available at `~/.config/gpd/bin/uv` and on the agent's PATH.
**Rebuilds triggered:** yes (Rust changes to lib.rs and gpd_setup.rs)
