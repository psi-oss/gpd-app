# Config Persistence Architecture (Decision 0.A)

**Status:** LANDED — Option B implemented at commit `d1945f9cfc`.
**Decided:** 2026-04-22
**Decided by:** claude
**Supersedes:** parts of PR #14, PR #22 premise

---

## Problem

GPD ships a managed config to the OpenCode sidecar via the `OPENCODE_CONFIG_CONTENT` environment variable. It also sets `OPENCODE_CONFIG_DIR` to `~/.gpd/`, expecting PATCH operations to persist user edits there. Neither assumption holds in the current codebase.

**Current state (verified on `gpd` HEAD, 2026-04-22):**

| Layer | File / route | Targets |
|---|---|---|
| Loader "global" tier | `config.ts:1239-1263` `loadGlobal()` | Reads `Global.Path.config/{config.json,opencode.json,opencode.jsonc}` ONLY. `Global.Path.config` = `~/.config/opencode/` on Linux/macOS. **Does not read `OPENCODE_CONFIG_DIR`.** |
| Loader "local" tier | `config.ts:1357, 1422-1468` | Reads `OPENCODE_CONFIG_DIR` entries, treats them as project-local. |
| Loader "env" merge | `config.ts:1461-1467` | Parses `OPENCODE_CONFIG_CONTENT` verbatim, highest precedence after project settings. |
| Write — `/config` | `server/instance/config.ts:57` → `Config.update` → `config.ts:1593-1601` | Writes `${InstanceState.directory}/config.json` — per-instance, NOT `opencode.json`. |
| Write — `/global/config` | `server/instance/global.ts:159-183` → `Config.updateGlobal` → `config.ts:1620-1639` | Writes `globalConfigFile()` = first existing of `~/.config/opencode/{opencode.jsonc,opencode.json,config.json}`. |

**Consequence.** The user's model choice in the UI flows through `/config` (project-local) or `/global/config` (`~/.config/opencode/`). Neither writes `~/.gpd/opencode.json`. On next startup, `OPENCODE_CONFIG_CONTENT` reinjects the hardcoded model from `packages/desktop/src-tauri/src/gpd_setup.rs::build_config_json` — overriding both targets because env-tier beats global-tier and project-tier.

PR #14 attempts to fix this by repointing `globalConfigFile()` to `OPENCODE_CONFIG_DIR` AND rerouting PATCH `/config` to `updateGlobal`. Both changes are scope creep and create read/write asymmetry: the writer would target `$OPENCODE_CONFIG_DIR/opencode.json` while `loadGlobal` still reads `~/.config/opencode/`.

PR #22 removes the `model` key from `OPENCODE_CONFIG_CONTENT`, believing PATCH persists to `$OPENCODE_CONFIG_DIR/opencode.json`. It doesn't. After PR #22 alone, model selection falls back to client-local localStorage at `packages/app/src/context/models.tsx:30-37` + `packages/app/src/context/local.tsx:143-172`.

## Constraint checklist

Any chosen architecture must satisfy:

1. Fresh-install default model (currently `gpd/claude-sonnet-4-6`) reaches the sidecar without user intervention.
2. User model change via UI survives app restart, WebKit storage wipe, and sidecar respawn.
3. Repair / re-init paths (`run_first_setup`, `repair_gpd_venv`, marker-missing re-entry at `lib.rs:520-529`) do NOT clobber a user-saved model.
4. User can edit the config file manually if they want (physics professors will tweak things).
5. MCP server entries are refreshable by the Rust side (`inject_provider_config` overwrites paths to fix stale venv references — see docs/CHANGES.md "Iteration 3").
6. Compatible with the existing TOS gate flow (`packages/app/src/components/tos-upgrade-gate.tsx` writes into auth.json after TOS accept; not into config directly — but any config write from UI must happen AFTER TOS accept, and this is already enforced by SetupGate layering).

## Options

### Option A — Drop `OPENCODE_CONFIG_CONTENT`, write a real file

First-run code in `gpd_setup.rs` writes `$OPENCODE_CONFIG_DIR/opencode.json` on disk. Normal config discovery chain loads it at the "local" tier. PATCH `/config` writes per-project config.json as today. PATCH `/global/config` writes `~/.config/opencode/opencode.json` as today — but we do not ship anything to this path, so GPD effectively stops using the "global" tier.

**Pros:**
- One config source. No env-var override trap.
- User-editable (they can open `~/.gpd/opencode.json` in a text editor).
- Re-uses the existing loader without modifications.
- Repair paths can check `if !file.exists()` and skip, preserving user edits.

**Cons:**
- Rust side needs a proper JSON merge when refreshing MCP entries on venv repair (vs the current "overwrite env var" approach). Not hard — `serde_json::Value` supports structural merge.
- Loss of the "inject from outside opencode" hook means any GPD-only semantic (e.g., forcing `"permission": "allow"`) must be re-applied by editing the file, not by env override. Users who edit the file might lock themselves out of permission defaults; we need explicit handling.
- Requires migration logic on first launch after this change: detect that `OPENCODE_CONFIG_CONTENT` was the authoritative source, read it, write the file once, then unset the env var. Otherwise old + new coexist.

### Option B — Promote `OPENCODE_CONFIG_DIR` to a first-class global tier

Extend `loadGlobal` at `config.ts:1239` to check `$OPENCODE_CONFIG_DIR/{config.json,opencode.json,opencode.jsonc}` BEFORE `Global.Path.config/*` (or instead of). Extend `globalConfigFile` at `config.ts:1087` similarly. `OPENCODE_CONFIG_CONTENT` stays as env-level override for defaults ONLY (strip `model` per PR #22's direction). PATCH `/global/config` rounds-trips through the new target.

**Pros:**
- Keeps env-var injection as the "defaults" mechanism. `inject_provider_config` still useful for refreshing MCP paths and forcing `"permission": "allow"` via the env-var override each launch.
- Minimal surface change: two small helpers updated; `/global/config` semantics unchanged from the caller's perspective.
- Repair paths continue to use env-var injection (idempotent by design).

**Cons:**
- Still two config sources (env + file) — merge precedence must be documented carefully.
- Env-var override always wins, so `inject_provider_config` accidentally forcing `model` again (the PR #22 bug) would silently re-break. We have to be disciplined about what goes in `build_config_json` — NEVER include user-mutable keys.
- More total code than Option A.

### Option C — Hybrid with explicit `defaults` vs `persistent`

Split `OPENCODE_CONFIG_CONTENT` responsibilities: keep it for strictly-GPD-managed keys (MCP paths, `enabled_providers`, `permission`) and write user-mutable keys (`model`, theme, user prefs) to `$OPENCODE_CONFIG_DIR/opencode.json`. Loader merge order (lowest → highest): Global.Path → OPENCODE_CONFIG_DIR file → OPENCODE_CONFIG_CONTENT → project.

**Pros:**
- Clear separation of concerns.
- Env override for GPD infrastructure; file for user state.

**Cons:**
- Highest implementation cost.
- Requires explicit allowlist/denylist logic to decide which keys go where. Drift risk.
- More moving parts for migration.

## Decision

**Option B — promote `OPENCODE_CONFIG_DIR` to a first-class global tier.**

### Rationale

- Minimizes code change: two helpers, one loader path, no migration for existing installs.
- Preserves the `inject_provider_config` mechanism, which we already rely on for MCP path refresh (docs/CHANGES.md "Iteration 3") and which is the cleanest way to bump managed config on sidecar upgrades.
- Option A is architecturally cleaner but forces us to build JSON-merge logic in Rust and a migration path. Not worth the churn when Option B closes the persistence gap.
- Option C is theoretically ideal but the key-split policy is the kind of thing that silently drifts over time. Pass.

### Scope of the change

1. **`packages/opencode/src/config/config.ts`**
   - `globalConfigFile()` at `:1087`: check `$OPENCODE_CONFIG_DIR/{opencode.jsonc,opencode.json,config.json}` candidates first, fall through to `Global.Path.config`.
   - `loadGlobal()` at `:1239`: add a `$OPENCODE_CONFIG_DIR` read after the three `Global.Path.config` reads. Same `mergeDeep` chain.
   - Precedence: `Global.Path.config < OPENCODE_CONFIG_DIR < OPENCODE_CONFIG_CONTENT < project-local`. Document.
2. **`packages/desktop/src-tauri/src/gpd_setup.rs`**
   - `inject_provider_config` stops writing `model` (already the PR #22 intent — lands with Task 3.1).
   - `inject_provider_config` still writes MCP entries + `enabled_providers` + `permission` — these are managed, not user-mutable.
   - Preserve existing `model` in the user's `$OPENCODE_CONFIG_DIR/opencode.json` across repairs. Guard insert.
3. **Docs**
   - `docs/GPD_DISTRIBUTION.md` "How the welcome screen works" section: add a paragraph about config sources + precedence.
   - `docs/CHANGES.md`: append an entry when the code lands.

### Task remapping

- **Task 3.1** becomes: (a) ADD `$OPENCODE_CONFIG_DIR` to `globalConfigFile` + `loadGlobal`. (b) Remove `obj.insert("model", ...)` from `build_config_json` (PR #22's useful change). (c) In `inject_provider_config`, NEVER write `model`; let the sidecar pick up user's saved value from the `OPENCODE_CONFIG_DIR` file.
- Drop PR #14's PATCH `/config` → `updateGlobal` route change entirely. PATCH `/config` stays project-local. PATCH `/global/config` now rounds-trips through `OPENCODE_CONFIG_DIR`.
- Drop PR #14's `command`/`agent` strip at `server/instance/config.ts:57-64`. Those fields can be written via `/config` (project-local) unchanged.

### Acceptance tests

1. Clean install: sidecar starts → `/v1/models` lists `gpd/claude-sonnet-4-6` as default.
2. Change model via UI → restart app → UI shows saved model.
3. Trigger repair (delete `.venv`, relaunch) → saved model survives.
4. Edit `~/.gpd/opencode.json` manually, set `"theme": "foo"` → relaunch → theme applied.
5. `OPENCODE_CONFIG_CONTENT` override still wins for `"permission"` — user cannot disable it by editing their file.

### Out of scope for this decision

- JSONC round-trip for `command`/`agent` (PR #14 justification — unsubstantiated, see `docs/PR-REVIEW-2026-04-22.md` § PR #14).
- Remote-workspace `/config` semantics (separate concern, tracked in Task 1.1 + Task 2.3/2.4).

## Veto

Revert this commit + the Task 3.1 commit if the precedence rule or the managed-vs-user split is wrong. Document counter-proposal here.
