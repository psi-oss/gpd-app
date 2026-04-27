# Security

## IMPORTANT

We do not accept AI-generated security reports. We receive a large number of
these and do not have the resources to review them all. Submitting one will
result in an automatic ban from the project.

## Threat Model

### Overview

GPD (Get Physics Done) is a Tauri desktop app that wraps an OpenCode-derived
sidecar plus a Python `get-physics-done` runtime. It runs locally on the
researcher's workstation. The agent has access to shell execution, file
operations, web access, and a curated set of MCP servers (arxiv,
conventions, error patterns, etc.). Logs of every session are uploaded to
PSI-controlled GCS via the LiteLLM proxy described in `docs/LOGGING.md`.

### No Sandbox

GPD does **not** sandbox the agent. The permission system is a UX safety
net — it prompts before executing shell commands or writing files — not
a security boundary. If you need true isolation, run GPD inside a VM or
container.

### Network Trust

GPD's sidecar talks to PSI's Railway-hosted LiteLLM proxy
(`litellm-production-46bb.up.railway.app`) using the per-user virtual key
the user pastes during onboarding. Anything the user types into the GPD
chat reaches PSI's proxy and the upstream model providers (Anthropic,
OpenAI, Google) per the providers' published policies. See
`docs/LOGGING.md` for what gets persisted to GCS and the retention
schedule.

### Out of Scope

| Category                        | Rationale                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| **Sandbox escapes**             | Permission system is not a sandbox (see above)                                         |
| **LLM provider data handling**  | Data sent to upstream model providers via the LiteLLM proxy follows their policies     |
| **MCP server behaviour**        | The `get-physics-done` MCP server set is in scope; user-added external MCPs are not    |
| **Malicious config files**      | Users control their own config; modifying it is not an attack vector                   |
| **macOS Gatekeeper / TCC**      | Releases are ad-hoc-signed pending Apple Developer enrolment; first-run prompts are an Apple-Gatekeeper artefact, not a GPD vulnerability |

### In Scope

- The desktop binary published to `psi-oss/gpd-app` releases (`.dmg`, `.deb`, `.exe`)
- The installer scripts hosted at `download.gpd.psi.inc` (`install`, `install.ps1`, `uninstall*`)
- The LiteLLM proxy hooks under `infra/litellm/gpd_log/`, `gpd_tos/`, `gpd_consent/`
- The Tauri Rust shell under `packages/desktop/src-tauri/`
- The OpenCode-derived sidecar under `packages/opencode/`

---

# Reporting Security Issues

To report a security issue, please use the GitHub Security Advisory
["Report a Vulnerability"](https://github.com/psi-oss/gpd-app/security/advisories/new)
tab on the `psi-oss/gpd-app` repository.

The team will respond with next steps and keep you informed through to a
fix and disclosure, and may ask for additional information or guidance.

## Escalation

If you do not receive an acknowledgement of your report within 6 business
days, please email `security@psi.inc`.
