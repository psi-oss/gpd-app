# GPD Manual Full Exploration

Manual, opt-in release exploration for the macOS desktop app. This is not a
nightly job and does not run on PRs or pushes.

## What "Full" Means Here

This harness does not attempt literal exhaustive state-space testing. It does
attempt full **rendered-surface coverage** for seeded states:

- Launch a debug GPD desktop build in an isolated test home.
- Seed logged-in/onboarded state when `GPD_EXPLORER_KEY` is provided.
- Visit core app states: home, project, session list, session detail, settings.
- Inventory every visible interactive element in those states.
- Require visible controls to be labeled by text, `aria-label`, or `data-action`.
- Classify controls as `passive`, `input`, `confirmable`, `external`, `action`, or `disabled`.
- Click reversible/passive controls within the configured action budget.
- Focus and reversibly edit visible text inputs/contenteditable controls.
- Open confirmable/destructive controls and cancel them.
- Fail if app code uses `window.alert`, `window.confirm`, or `window.prompt`.
- Fail on uncaught JS errors, unhandled rejections, empty body, or frozen bridge.

The important distinction: we are not proving all possible state combinations.
We are making the actual rendered control universe visible and forcing each
safe/reversible class through the app once per seeded state.

## Local Mac Run

Use this lane for developer builds. It builds or points at `GPD Dev.app`.

Prerequisites:

```bash
cd /Users/cmaloney111/Documents/psi/repos/gpd-opencode-fresh
cd packages/desktop/tests-gui
uv sync --extra dev
brew install cliclick
```

Build or point at a debug app:

```bash
cd /Users/cmaloney111/Documents/psi/repos/gpd-opencode-fresh/packages/desktop
bun run tauri build --debug --bundles app
```

Run the manual exploration:

```bash
cd /Users/cmaloney111/Documents/psi/repos/gpd-opencode-fresh
GPD_EXPLORER_KEY="$GPD_TEST_KEY" \
bash packages/desktop/tests-gui/scripts/run_manual_full_exploration.sh
```

## Parallels Installer-Backed Mac Run

Use this lane for release confidence. The app under test is installed by
`install-gpd/install` into `/Applications/GPD.app`; the repo inside the guest is
only the test harness.

From the host:

```bash
GPD_PARALLELS_MAC_VM="GPD macOS BRD" \
GPD_PARALLELS_GUEST_USER="tester" \
GPD_PARALLELS_GUEST_PASSWORD="tester" \
bash packages/desktop/tests-gui/scripts/run_brd_mac_parallels.sh install-local

GPD_PARALLELS_MAC_VM="GPD macOS BRD" \
GPD_PARALLELS_GUEST_USER="tester" \
GPD_PARALLELS_GUEST_PASSWORD="tester" \
bash packages/desktop/tests-gui/scripts/run_brd_mac_parallels.sh verify-install
```

Then run exploration against the installed app:

```bash
GPD_PARALLELS_MAC_VM="GPD macOS BRD" \
GPD_PARALLELS_GUEST_USER="tester" \
GPD_PARALLELS_GUEST_PASSWORD="tester" \
GPD_PARALLELS_GUEST_REPO="/Users/tester/gpd-opencode-fresh" \
GPD_BRD_DEPTH=full \
bash packages/desktop/tests-gui/scripts/run_brd_mac_parallels.sh guest-run-installed
```

Production release bundles intentionally do not expose the debug MCP socket used
by the explorer. The installer-backed lane therefore runs release smoke checks
and the macOS Accessibility-backed consent gate smoke test rather than the MCP
explorer:

```bash
GPD_PARALLELS_MAC_VM="GPD macOS BRD" \
GPD_PARALLELS_GUEST_USER="tester" \
GPD_PARALLELS_GUEST_PASSWORD="tester" \
GPD_PARALLELS_GUEST_REPO="/Users/tester/gpd-opencode-fresh" \
bash packages/desktop/tests-gui/scripts/run_brd_mac_parallels.sh release-smoke
```

`guest-run-installed` is reserved for the future full release UI driver. Today,
release UI coverage starts with `test_release_tos_ax.py`; broader release
exploration still needs additional AX/OS-input surfaces before it can replace
the debug MCP explorer. The installed-product lane uses
`$HOME/.gpd/uv-bootstrap/uv` when the installer provided it, avoiding
preinstalled Python as a product prerequisite.

`GPD_EXPLORER_KEY`, `GPD_TEST_KEY`, or `GPD_API_KEY` is required by default.
Without one, the runner exits before exploring so it does not produce a
misleading "full app" run that only clicks around the API-key page.

Useful variants:

```bash
# Inventory + explorer only.
GPD_EXPLORER_DEPTH=inventory \
GPD_EXPLORER_KEY="$GPD_TEST_KEY" \
bash packages/desktop/tests-gui/scripts/run_manual_full_exploration.sh

# More clicks.
GPD_EXPLORER_MAX_ACTIONS=500 \
GPD_EXPLORER_KEY="$GPD_TEST_KEY" \
bash packages/desktop/tests-gui/scripts/run_manual_full_exploration.sh

# Include lifecycle/restart tests.
GPD_EXPLORER_RUN_DESTRUCTIVE=1 \
GPD_EXPLORER_KEY="$GPD_TEST_KEY" \
bash packages/desktop/tests-gui/scripts/run_manual_full_exploration.sh

# Include live LLM-backed flows.
GPD_EXPLORER_RUN_REAL_BACKEND=1 \
GPD_EXPLORER_KEY="$GPD_TEST_KEY" \
GPD_TEST_ANTHROPIC_KEY="$GPD_TEST_KEY" \
bash packages/desktop/tests-gui/scripts/run_manual_full_exploration.sh
```

Artifacts land under:

```text
packages/desktop/tests-gui/artifacts/manual-full-<timestamp>/
```

Local runs leave the debug app open by default so failures can be inspected
manually. To force teardown, set:

```bash
GPD_EXPLORER_QUIT_APP=1 \
GPD_EXPLORER_KEY="$GPD_TEST_KEY" \
bash packages/desktop/tests-gui/scripts/run_manual_full_exploration.sh
```

High-signal files:

- `summary.md` — command parameters and per-group exit codes.
- `inventory.json` — all visible controls across seeded states.
- `passive-clicks.json` — reversible controls clicked.
- `inputs.json` — inputs focused and reversibly edited.
- `confirmable-clicks.json` — destructive/confirmable openers checked and canceled.
- `junit-*.xml` and `*.log` — pytest outputs per group.

## GitHub Manual Run

Use **Actions → GPD Manual Full Exploration → Run workflow**.

Inputs:

- `depth=inventory|surfaces|flows|full`
- `max_actions`, default `200`
- `run_destructive`, default `false`
- `run_real_backend`, default `false`
- `strict`, default `true`

The workflow is `workflow_dispatch` only. It builds a debug macOS app on the
runner, runs the same script, and uploads artifacts. GitHub-hosted macOS
runners may still lack Accessibility permissions for AX-heavy tests; the
explorer itself is primarily MCP/DOM-driven.

## Safety

The script sets an isolated `HOME` by default:

```text
GPD_EXPLORER_ISOLATE_HOME=1
```

That keeps auth, WebKit data, app config, and sidecar state away from the
developer's real GPD profile. To intentionally use the current home, set:

```bash
GPD_EXPLORER_ISOLATE_HOME=0
```

Do that only for debugging a specific local-only reproduction.

To intentionally test only logged-out onboarding, opt out of the key
requirement:

```bash
GPD_EXPLORER_REQUIRE_KEY=0 \
GPD_EXPLORER_DEPTH=inventory \
bash packages/desktop/tests-gui/scripts/run_manual_full_exploration.sh
```

## Interpreting Failures

- Native modal failure means product code called `window.alert`,
  `window.confirm`, or `window.prompt`; replace it with an app-owned dialog.
- Small inventory usually means onboarding/TOS blocked the app or the route
  rendered blank.
- Unlabeled control means a button/input is not accessible and cannot be
  reliably driven by the harness.
- Missing confirmable controls in strict mode usually means the logged-in state
  was not seeded or the settings account panel did not render.
- A frozen bridge means the app event loop is stuck, the MCP listener died, or a
  native OS dialog is blocking WebKit.

## Current Boundary

This is mac-first. The existing GUI harness is macOS-centric (`.app`,
AppleScript, Accessibility, Unix MCP socket). Windows parity needs a separate
driver layer around WebView2 and Windows UI Automation before it can make the
same "rendered control inventory + reversible click" claim.
