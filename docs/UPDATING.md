# Updating GPD to a New OpenCode Release

## Overview

GPD is a single squashed commit on top of an upstream OpenCode release tag. When OpenCode releases a new version, we rebase our commit onto the new tag.

```
Before:  v1.4.6 → [GPD commit]
After:   v1.5.0 → [GPD commit rebased]
```

## Prerequisites

```bash
# One-time setup: add upstream remote
cd gpd-opencode-fresh  # or wherever you cloned psi-oss/gpd-app
git remote add upstream https://github.com/anomalyco/opencode.git
git remote add psi-oss https://github.com/psi-oss/gpd-app.git
```

## Step-by-Step Rebase

### 1. Fetch upstream tags

```bash
git fetch upstream --tags
```

### 2. Check the latest upstream release tag

```bash
# List recent tags (non-vscode)
git tag -l 'v1.*' --sort=-v:refname | head -5
```

### 3. Note the current base tag

Check which tag our GPD commit is based on:

```bash
git log --oneline gpd | tail -2
# The second-to-last line is the upstream tag commit
```

Or check the commit message which references the base version.

### 4. Rebase onto the new tag

```bash
git checkout gpd
git rebase --onto v<NEW> v<OLD> gpd
```

For example, rebasing from v1.4.6 to v1.5.0:

```bash
git rebase --onto v1.5.0 v1.4.6 gpd
```

### 5. Resolve conflicts

Conflicts typically occur in:

| File | Likelihood | Resolution |
|------|-----------|------------|
| `packages/app/src/i18n/en.ts` | **High** | Keep our "GPD" replacements, accept new upstream strings |
| `packages/app/src/i18n/*.ts` (other locales) | Medium | Same — keep "GPD", accept new strings |
| `packages/ui/src/theme/context.tsx` | Medium | Keep our theme default |
| `packages/app/src/app.tsx` | Low-Medium | Keep our SetupGate, merge any upstream changes |
| Everything else | Low | Our changes are isolated |

For each conflict:
```bash
# Edit the file, resolve conflicts
git add <file>
git rebase --continue
```

### 6. Verify the build

```bash
# Check Rust compiles
cd packages/desktop/src-tauri
mkdir -p gpd-sidecar-bundle && touch gpd-sidecar-bundle/.gitkeep
cargo check

# Check TypeScript compiles
cd ../../..
bun install
bun turbo typecheck
```

### 7. Force push

```bash
git push psi-oss gpd --force-with-lease
```

### 8. Trigger a release

```bash
# Typical case — version auto-detected from get-physics-done
gh workflow run gpd-release.yml --repo psi-oss/gpd-app --ref gpd

# Explicit override
gh workflow run gpd-release.yml --repo psi-oss/gpd-app --ref gpd -f version=<NEW_VERSION>
```

This creates a **draft** release. Inspect it, then publish:

```bash
gh workflow run gpd-publish-draft.yml --repo psi-oss/gpd-app --ref gpd
```

Full release workflow reference: `docs/RELEASING.md`.

### 9. Update the download page

The `gpd-download-page.yml` workflow fires on `release:published` and regenerates `https://download.gpd.psi.inc` automatically.

## What to Check After Rebasing

- [ ] `cargo check` passes in `packages/desktop/src-tauri/`
- [ ] Branding strings still say "GPD" (not reverted to "OpenCode")
- [ ] `gpd_setup.rs` still has correct LiteLLM URL and model list
- [ ] `welcome-screen.tsx` still exists and imports correctly
- [ ] `gpd-release.yml` workflow still has all our custom steps (sidecar build, etc.)
- [ ] Icons are still PSI Ψ (check `packages/desktop/src-tauri/icons/dev/32x32.png`)

## When NOT to Rebase

- **Upstream changed the Tauri config schema** — our `tauri.conf.json` changes may need manual adaptation
- **Upstream refactored `app.tsx`** — our SetupGate integration may need adjustment
- **Upstream changed the provider system** — our `OPENCODE_CONFIG_CONTENT` approach may need updates

In these cases, read the upstream changelog first, understand the changes, then rebase carefully.

## Adding New Models After Rebase

If new AI models were released (e.g., Claude 5.0), update:

1. **LiteLLM** — add via API (`/model/new`)
2. **`packages/opencode/src/provider/gpd-models.ts`** — add display metadata and any model-specific reasoning-effort overrides
3. **`gpd_setup.rs`** — add to `build_config_json()` model list for the desktop fallback config

## Emergency: Rebase Goes Wrong

```bash
# Abort the rebase and go back to the previous state
git rebase --abort

# If you already pushed a broken rebase, restore from reflog
git reflog
git reset --hard gpd@{1}  # go back one step
git push psi-oss gpd --force-with-lease
```

## Cadence

- **Check for new upstream tags** every few days
- **Rebase when a new stable tag is released** (not on every dev commit)
- **Don't rebase on pre-release/beta tags** unless testing
