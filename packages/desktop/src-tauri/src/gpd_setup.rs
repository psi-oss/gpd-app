//! GPD first-run orchestration.
//!
//! On first launch:
//! 1. Provisions Python via bundled `uv` (or finds system Python >= 3.11)
//! 2. Creates a GPD venv and installs `get-physics-done[arxiv]`
//! 3. Runs `gpd install opencode --global` to deploy commands, agents, docs
//! 4. Injects LiteLLM provider config into opencode.json
//! 5. Writes .gpd-initialized marker
//!
//! MCP servers run locally via real Python from the venv.
//! Subsequent launches skip all of this (marker file check).

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::process::Command;
use tokio::time::timeout;

/// GPD config directory name under ~/.config/
const GPD_CONFIG_DIR_NAME: &str = "gpd";

/// Marker file written after successful first-run setup
const GPD_INIT_MARKER: &str = ".gpd-initialized";

/// Marker file recording the SHA256 of the python-manifest.json that was
/// last reconciled against the user's venv. Compared against the current
/// bundled manifest on every launch — if they match, the reconciler short-
/// circuits without touching pip. See `reconcile_manifest`.
const GPD_DEPS_HASH_MARKER: &str = ".gpd-deps-hash";

/// Tauri resource path for the Python dependency manifest. Resolved via
/// `app.path().resolve(..., BaseDirectory::Resource)`.
const PYTHON_MANIFEST_RESOURCE: &str = "python-manifest.json";

/// LiteLLM proxy URL
const LITELLM_URL: &str = "https://litellm-production-46bb.up.railway.app/v1";

/// Pinned PyPI version of the `get-physics-done` package that the GPD
/// venv is seeded with. Empty string = install the latest version PyPI
/// resolves at first-run time. Mirrors `install-gpd/install`'s
/// `GPD_PACKAGE_VERSION` (also empty by default since 2026-04-27) so
/// installer-first and desktop-first onboarding produce equivalent
/// venvs. Set to `"X.Y.Z"` to pin a specific release for
/// reproducibility (e.g. for a frozen pilot cohort); leave empty to
/// track latest. The pip command builds either `get-physics-done` or
/// `get-physics-done==X.Y.Z` based on whether this is empty.
///
/// Why latest instead of pinned: PyPI's resolver picks the highest
/// version compatible with our PBS Python (3.13). Pilot users get new
/// agent + MCP server fixes without waiting for a desktop release.
/// Tradeoff: install reproducibility drops — same desktop binary on
/// different days may bootstrap to different `get-physics-done`
/// versions. Acceptable for pilot; bump to a real pin when a hard
/// reproducibility requirement appears.
const GPD_PACKAGE_VERSION: &str = "";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Builds the OPENCODE_CONFIG_CONTENT JSON with provider config and
/// MCP server definitions pointing to the venv Python interpreter.
pub fn build_config_json() -> String {
    let python = gpd_python();
    // Escape backslashes for JSON string embedding (Windows paths contain `\`).
    // Without this, `\U`, `\v`, `\S`, etc. in paths like
    // `C:\Users\foo\.config\gpd\.venv\Scripts\python.exe` are parsed as invalid
    // JSON escape sequences and the entire OPENCODE_CONFIG_CONTENT is rejected.
    let p = python.to_string_lossy().replace('\\', "\\\\");

    let mcp_servers = format!(r#"{{
        "gpd-conventions": {{"type":"local","command":["{p}","-m","gpd.mcp.servers.conventions_server"],"enabled":true,"environment":{{"LOG_LEVEL":"WARNING"}}}},
        "gpd-errors": {{"type":"local","command":["{p}","-m","gpd.mcp.servers.errors_mcp"],"enabled":true,"environment":{{"LOG_LEVEL":"WARNING"}}}},
        "gpd-patterns": {{"type":"local","command":["{p}","-m","gpd.mcp.servers.patterns_server"],"enabled":true,"environment":{{"LOG_LEVEL":"WARNING"}}}},
        "gpd-protocols": {{"type":"local","command":["{p}","-m","gpd.mcp.servers.protocols_server"],"enabled":true,"environment":{{"LOG_LEVEL":"WARNING"}}}},
        "gpd-skills": {{"type":"local","command":["{p}","-m","gpd.mcp.servers.skills_server"],"enabled":true,"environment":{{"LOG_LEVEL":"WARNING"}}}},
        "gpd-state": {{"type":"local","command":["{p}","-m","gpd.mcp.servers.state_server"],"enabled":true,"environment":{{"LOG_LEVEL":"WARNING"}}}},
        "gpd-verification": {{"type":"local","command":["{p}","-m","gpd.mcp.servers.verification_server"],"enabled":true,"environment":{{"LOG_LEVEL":"WARNING"}}}},
        "gpd-arxiv": {{"type":"local","command":["{p}","-m","gpd.mcp.servers.arxiv_bridge"],"enabled":true}}
    }}"#);

    let m = r#""modalities":{"input":["text","image","pdf"],"output":["text"]}"#;
    let mg = r#""modalities":{"input":["text","image","pdf","video","audio"],"output":["text"]}"#;
    let mt = r#""modalities":{"input":["text"],"output":["text"]}"#;
    // See comment in inject_provider_config() about why there's no
    // "env" field on the gpd provider — opencode falls back to
    // auth.json (populated by the installer) when env is absent.
    // NOTE: no top-level "model" key here. The default model lives in
    // $OPENCODE_CONFIG_DIR/opencode.json (written by inject_provider_config
    // on first install). The env-var tier used to include "model" too,
    // which overrode the user's saved model on every launch because env
    // tier wins over the global-file tier. See Decision 0.A
    // (docs/CONFIG_ARCHITECTURE.md) and Task 3.1.
    format!(r#"{{"provider":{{"gpd":{{"name":"GPD (PSI)","api":"{url}","models":{{"claude-opus-4-6":{{"name":"Claude Opus 4.6","tool_call":true,"reasoning":true,"attachment":true,"temperature":true,{m},"limit":{{"context":1000000,"output":128000}}}},"claude-sonnet-4-6":{{"name":"Claude Sonnet 4.6","tool_call":true,"reasoning":true,"attachment":true,"temperature":true,{m},"limit":{{"context":1000000,"output":64000}}}},"claude-haiku-4-5":{{"name":"Claude Haiku 4.5","tool_call":true,"reasoning":true,"attachment":true,"temperature":true,{m},"limit":{{"context":200000,"output":64000}}}},"gpt-5.5":{{"name":"GPT 5.5","tool_call":true,"reasoning":true,"attachment":true,"temperature":true,{m},"limit":{{"context":1050000,"output":128000}}}},"gpt-5.4":{{"name":"GPT 5.4","tool_call":true,"reasoning":true,"attachment":true,"temperature":true,{m},"limit":{{"context":1050000,"output":131072}}}},"gpt-5.4-mini":{{"name":"GPT 5.4 mini","tool_call":true,"reasoning":true,"attachment":true,"temperature":true,{m},"limit":{{"context":1050000,"output":131072}}}},"gpt-5.4-nano":{{"name":"GPT 5.4 nano","tool_call":true,"reasoning":true,"attachment":true,"temperature":true,{m},"limit":{{"context":1050000,"output":131072}}}},"gpt-5.3-codex":{{"name":"GPT 5.3 Codex","tool_call":true,"attachment":true,"temperature":true,{m},"limit":{{"context":1000000,"output":32768}}}},"gpt-4.1":{{"name":"GPT 4.1","tool_call":true,"attachment":true,"temperature":true,{m},"limit":{{"context":1000000,"output":32768}}}},"gpt-4.1-mini":{{"name":"GPT 4.1 mini","tool_call":true,"attachment":true,"temperature":true,{m},"limit":{{"context":1000000,"output":32768}}}},"o4-mini":{{"name":"o4-mini (reasoning)","tool_call":true,"reasoning":true,"temperature":true,{mt},"limit":{{"context":200000,"output":100000}}}},"gemini-3.1-pro-preview":{{"name":"Gemini 3.1 Pro","tool_call":true,"reasoning":true,"attachment":true,"temperature":true,{mg},"limit":{{"context":1000000,"output":65536}}}},"gemini-3-flash-preview":{{"name":"Gemini 3 Flash","tool_call":true,"reasoning":true,"attachment":true,"temperature":true,{mg},"limit":{{"context":1000000,"output":65536}}}},"gemini-3.1-flash-lite-preview":{{"name":"Gemini 3.1 Flash-Lite","tool_call":true,"attachment":true,"temperature":true,{m},"limit":{{"context":1000000,"output":65536}}}}}}}}}},"enabled_providers":["gpd"],"mcp":{mcp}}}"#,
        url = LITELLM_URL,
        mcp = mcp_servers,
    )
}

/// Returns the GPD home directory (~/.gpd, or $GPD_HOME if set).
///
/// This is the single base directory that BOTH the CLI installer
/// (install-gpd/install and install-gpd/windows_11/install.ps1) AND
/// the desktop app use for their bootstrap state: Python venv,
/// get-physics-done package, LiteLLM config, and the
/// `.gpd-initialized` marker.
///
/// When the CLI installer runs first, it pre-populates everything
/// under this path so the desktop app's `run_first_setup` short-
/// circuits via `is_venv_valid()` on first launch — no uv reinstall,
/// no pip reinstall, no cascade of console windows.
///
/// Before this unification (tracked as product bug 2026-04-21), the
/// desktop app used `~/.config/gpd/` while the installer used
/// `~/.gpd/`, so each re-did the other's work.
pub fn config_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("GPD_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(home);
    }
    dirs::home_dir()
        .expect("cannot determine home directory")
        .join(".gpd")
}

/// Returns true if GPD has already been initialized
pub fn is_initialized() -> bool {
    config_dir().join(GPD_INIT_MARKER).exists()
}

/// Returns true when the GPD venv is present and usable.
///
/// All three of the following must hold:
/// 1. The venv Python binary exists on disk.
/// 2. That binary can execute `import gpd; print('ok')` within 5 seconds.
/// 3. The `.gpd-initialized` marker file exists.
///
/// The function is intentionally synchronous-looking from the caller's
/// perspective because it blocks until the probe completes or times out.
pub async fn is_venv_valid() -> bool {
    let marker = config_dir().join(GPD_INIT_MARKER);
    if !marker.exists() {
        return false;
    }

    let python = gpd_python();
    if !python.exists() {
        return false;
    }

    let result = timeout(
        Duration::from_secs(5),
        Command::new(&python)
            .args(["-c", "import gpd; print('ok')"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .output(),
    )
    .await;

    match result {
        Ok(Ok(output)) => output.status.success(),
        _ => false,
    }
}

/// Tauri command: delete the init marker and re-run first-run setup.
///
/// Only the `.venv` directory is removed so project files in
/// `~/.config/gpd/` are preserved. Emits progress via the existing
/// `GpdFirstRunComplete` event when done.
#[tauri::command]
#[specta::specta]
pub async fn repair_gpd_venv(app: tauri::AppHandle) -> Result<(), String> {
    let config = config_dir();
    let marker = config.join(GPD_INIT_MARKER);
    let venv = gpd_venv_dir();

    tracing::info!("Repair requested: removing GPD venv and init marker");

    // Remove the venv directory (not other project files).
    if venv.exists() {
        std::fs::remove_dir_all(&venv)
            .map_err(|e| format!("Couldn't remove the GPD Python environment. Make sure no other app is using it. ({e})"))?;
        tracing::info!("Removed GPD venv at {}", venv.display());
    }

    // Remove the marker so the setup is unconditionally re-run.
    if marker.exists() {
        std::fs::remove_file(&marker)
            .map_err(|e| format!("Couldn't reset GPD setup. Try restarting the app. ({e})"))?;
    }

    run_first_setup(app).await
}

/// Run the full GPD first-run setup. Non-fatal — errors are logged,
/// and the marker file is only written on full success (retry next launch).
pub async fn run_first_setup(app: AppHandle) -> Result<(), String> {
    let config = config_dir();
    let uv = uv_path(&app)?;

    if !uv.exists() {
        return Err(format!("GPD installation is missing a required helper (uv) at {}. Try reinstalling the app.", uv.display()));
    }

    std::fs::create_dir_all(&config)
        .map_err(|e| format!("Couldn't create GPD's settings folder. Check disk space and folder permissions. ({e})"))?;

    tracing::info!(
        config = %config.display(),
        uv = %uv.display(),
        "Starting GPD first-run setup"
    );

    // Step 1: Ensure Python >= 3.11 is available
    let python = ensure_python(&uv).await?;

    // Step 2: Create GPD venv and install get-physics-done
    ensure_gpd_installed(&uv, &python).await?;

    // Step 3: Install commands, agents, reference docs
    run_gpd_install(&config).await?;

    // Step 4: Inject LiteLLM provider config
    inject_provider_config(&config)?;

    // Step 5: Mark as initialized
    let marker = config.join(GPD_INIT_MARKER);
    std::fs::write(&marker, "initialized")
        .map_err(|e| format!("GPD couldn't save its setup status. Try restarting the app. ({e})"))?;

    tracing::info!("GPD first-run setup completed");
    Ok(())
}

// ---------------------------------------------------------------------------
// Manifest reconciliation (existing-user dep upgrades)
// ---------------------------------------------------------------------------

/// One Python package the reconciler ensures is installed and importable.
///
/// `spec` is what gets passed to `uv pip install --upgrade` on probe-fail
/// (e.g. `arxiv-mcp-server[pdf]>=0.4.11`). `import_check` is the module
/// whose `import` MUST succeed in the venv — chosen to detect the specific
/// failure mode this package fixes (e.g. `pymupdf4llm` for the [pdf] extra,
/// not the package name itself).
#[derive(Debug, Deserialize)]
struct ManifestPackage {
    spec: String,
    import_check: String,
}

#[derive(Debug, Deserialize)]
struct PythonManifest {
    #[allow(dead_code)]
    version: u32,
    packages: Vec<ManifestPackage>,
}

/// Reconcile the user's `~/.gpd/venv` against the bundled
/// `python-manifest.json`. Probes each package's `import_check` module; on
/// failure runs `uv pip install --upgrade <spec>`.
///
/// Why: Tauri auto-update replaces the app bundle but never touches
/// `~/.gpd/venv/`. `is_venv_valid()` only checks `import gpd` succeeds,
/// never versions, so users who installed before a Python-side fix never
/// receive it. This reconciler is the bridge — it runs on every launch
/// (after the sidecar is healthy), short-circuits when the manifest SHA256
/// matches `~/.gpd/.gpd-deps-hash`, and only does pip work on the first
/// launch after a desktop release that bumps the manifest.
///
/// Fire-and-forget contract: this function should be invoked via
/// `tokio::spawn(...)` so it never blocks app startup. All errors are
/// returned for logging; the caller drops them. Failures are non-fatal —
/// the existing venv keeps working at its previous state, and the hash
/// marker is left untouched so the next launch retries.
pub async fn reconcile_manifest(app: AppHandle) -> Result<(), String> {
    let manifest_path = app
        .path()
        .resolve(PYTHON_MANIFEST_RESOURCE, tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Couldn't locate python-manifest.json bundled resource. ({e})"))?;

    let manifest_bytes = std::fs::read(&manifest_path)
        .map_err(|e| format!("Couldn't read python-manifest.json at {}. ({e})", manifest_path.display()))?;

    let hash_hex = hex::encode(Sha256::digest(&manifest_bytes));
    let hash_marker = config_dir().join(GPD_DEPS_HASH_MARKER);

    if let Ok(prev) = std::fs::read_to_string(&hash_marker) {
        if prev.trim() == hash_hex {
            tracing::debug!("python-manifest hash unchanged; reconciler skipping");
            return Ok(());
        }
    }

    let python = gpd_python();
    if !python.exists() {
        // First-run setup hasn't installed the venv yet. The first-run path
        // will install the right packages; reconciler defers until next launch.
        tracing::debug!("GPD venv not yet present; reconciler deferring");
        return Ok(());
    }

    let manifest: PythonManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("python-manifest.json is malformed. ({e})"))?;

    let uv = uv_path(&app)?;
    if !uv.exists() {
        return Err(format!("uv binary missing at {}", uv.display()));
    }

    let mut all_ok = true;

    for pkg in &manifest.packages {
        let ok = probe_import(&python, &pkg.import_check).await;
        if ok {
            tracing::debug!(import = %pkg.import_check, "manifest probe ok; skipping pip");
            continue;
        }

        tracing::info!(
            spec = %pkg.spec,
            import = %pkg.import_check,
            "manifest probe failed; running uv pip install --upgrade"
        );

        let result = timeout(
            Duration::from_secs(300),
            Command::new(&uv)
                .args([
                    "pip",
                    "install",
                    "--upgrade",
                    &pkg.spec,
                    "-p",
                    &python.to_string_lossy(),
                    "--quiet",
                ])
                .env("UV_HTTP_TIMEOUT", "120")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::null())
                .output(),
        )
        .await;

        match result {
            Ok(Ok(output)) if output.status.success() => {
                tracing::info!(spec = %pkg.spec, "manifest entry upgraded");
            }
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                tracing::warn!(spec = %pkg.spec, %stderr, "uv pip install --upgrade failed");
                all_ok = false;
            }
            Ok(Err(e)) => {
                tracing::warn!(spec = %pkg.spec, error = %e, "couldn't start uv");
                all_ok = false;
            }
            Err(_) => {
                tracing::warn!(spec = %pkg.spec, "uv pip install --upgrade timed out");
                all_ok = false;
            }
        }
    }

    // Only stamp the hash marker if every package reconciled cleanly. A partial
    // success leaves the marker stale so the next launch retries the failed
    // ones; a complete success means "we know the venv matches this manifest".
    if all_ok {
        let _ = std::fs::write(&hash_marker, &hash_hex);
        tracing::info!(hash = %hash_hex, "python-manifest reconciled");
    } else {
        tracing::info!("python-manifest reconciliation had errors; will retry next launch");
    }

    Ok(())
}

/// Probe whether `python -c "import {module}"` exits 0 within 5 seconds.
/// Returns false on any failure (missing module, syntax error, timeout, IO).
async fn probe_import(python: &Path, module: &str) -> bool {
    let cmd = format!("import {module}");
    let result = timeout(
        Duration::from_secs(5),
        Command::new(python)
            .args(["-c", &cmd])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .output(),
    )
    .await;

    matches!(result, Ok(Ok(output)) if output.status.success())
}

// ---------------------------------------------------------------------------
// Python provisioning
// ---------------------------------------------------------------------------

/// Returns the path to the bundled uv binary in the app's resources
fn uv_path(app: &AppHandle) -> Result<PathBuf, String> {
    let bin_name = if cfg!(windows) { "uv.exe" } else { "uv" };
    app.path()
        .resolve(format!("uv-bundle/{bin_name}"), tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("GPD's Python helper (uv) couldn't be located. Try reinstalling the app. ({e})"))
}

/// GPD venv location.
///
/// Matches the CLI installer layout:
///   Linux / macOS: ~/.gpd/venv/
///   Windows:       %USERPROFILE%\.gpd\venv\
///
/// Previously this was `config_dir().join(".venv")` which pointed at
/// ~/.config/gpd/.venv/ — a different directory from what the
/// installer built. Unified in the 2026-04-21 refactor.
fn gpd_venv_dir() -> PathBuf {
    config_dir().join("venv")
}

/// The Python interpreter inside the GPD venv
fn gpd_python() -> PathBuf {
    let venv = gpd_venv_dir();
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// Ensure a Python >= 3.11 interpreter is available.
/// First checks system Python. If none found, uses bundled uv to install one.
async fn ensure_python(uv: &Path) -> Result<PathBuf, String> {
    // Try system python3 first
    let python_cmd = if cfg!(windows) { "python" } else { "python3" };
    if let Ok(output) = Command::new(python_cmd)
        .args(["--version"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .output()
        .await
    {
        if output.status.success() {
            let version = String::from_utf8_lossy(&output.stdout);
            if is_python_3_11_or_later(&version) {
                tracing::info!("Using system Python: {}", version.trim());
                return Ok(PathBuf::from(python_cmd));
            }
        }
    }

    // No suitable system Python — install via uv
    tracing::info!("No system Python >= 3.11 found, installing via uv");

    let output = timeout(
        Duration::from_secs(120),
        Command::new(uv)
            .args(["python", "install", "3.12", "--quiet"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "Installing Python is taking too long. Check your internet connection and try again.".to_string())?
    .map_err(|e| format!("Couldn't start the Python installer. ({e})"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Couldn't install Python. {stderr}"));
    }

    // Locate the installed interpreter
    let find_output = Command::new(uv)
        .args(["python", "find", "3.12"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("Couldn't locate the installed Python. ({e})"))?;

    let python_path = String::from_utf8_lossy(&find_output.stdout).trim().to_string();
    if python_path.is_empty() {
        return Err("Python was installed but GPD couldn't locate it. Restart the app or reinstall.".to_string());
    }

    tracing::info!("uv-provisioned Python at: {python_path}");
    Ok(PathBuf::from(python_path))
}

fn is_python_3_11_or_later(version_output: &str) -> bool {
    let trimmed = version_output.trim();
    if let Some(rest) = trimmed.strip_prefix("Python ") {
        let parts: Vec<&str> = rest.split('.').collect();
        if parts.len() >= 2 {
            if let (Ok(3), Ok(minor)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
                return minor >= 11;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// GPD package installation
// ---------------------------------------------------------------------------

/// Create a dedicated GPD venv and install get-physics-done into it.
async fn ensure_gpd_installed(uv: &Path, python: &Path) -> Result<(), String> {
    let venv = gpd_venv_dir();

    if !venv.exists() {
        tracing::info!("Creating GPD venv at {}", venv.display());

        let output = timeout(
            Duration::from_secs(30),
            Command::new(uv)
                .args(["venv", &venv.to_string_lossy(), "-p", &python.to_string_lossy()])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::null())
                .output(),
        )
        .await
        .map_err(|_| "Setting up the Python environment is taking too long. Check your internet connection.".to_string())?
        .map_err(|e| format!("Couldn't set up the Python environment. ({e})"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Couldn't set up the Python environment. {stderr}"));
        }
    }

    tracing::info!("Installing get-physics-done[arxiv] into GPD venv");

    // Empty GPD_PACKAGE_VERSION = track latest from PyPI (matches the
    // CLI installer's behaviour). When set to "X.Y.Z" we pin via the
    // PEP 508 `==X.Y.Z` form. Pip with the bare name resolves to the
    // newest wheel compatible with our PBS Python at install time.
    let pypi_spec = if GPD_PACKAGE_VERSION.is_empty() {
        "get-physics-done[arxiv]".to_string()
    } else {
        format!("get-physics-done[arxiv]=={GPD_PACKAGE_VERSION}")
    };
    let output = timeout(
        Duration::from_secs(300),
        Command::new(uv)
            .args([
                "pip", "install",
                &pypi_spec,
                "-p", &gpd_python().to_string_lossy(),
                "--quiet",
            ])
            .env("UV_HTTP_TIMEOUT", "120")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "Installing GPD tools is taking too long. Check your internet connection.".to_string())?
    .map_err(|e| format!("Couldn't start the GPD tools installer. ({e})"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Couldn't install GPD tools. {stderr}"));
    }

    tracing::info!("get-physics-done installed successfully");

    // Symlink the bundled uv into the GPD config bin directory so the agent
    // can use `uv` to create per-project venvs and install packages on demand.
    // This way professors get project-level isolation (e.g., one project with
    // scipy, another with scikit-learn) without polluting the global GPD venv.
    let gpd_bin = config_dir().join("bin");
    let _ = std::fs::create_dir_all(&gpd_bin);
    let uv_link = gpd_bin.join("uv");
    if !uv_link.exists() {
        #[cfg(unix)]
        {
            let _ = std::os::unix::fs::symlink(uv, &uv_link);
            tracing::info!(link = %uv_link.display(), target = %uv.display(), "Symlinked uv into GPD bin");
        }
        #[cfg(windows)]
        {
            let _ = std::fs::copy(uv, &uv_link);
            tracing::info!(link = %uv_link.display(), "Copied uv into GPD bin");
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// GPD command/agent installation
// ---------------------------------------------------------------------------

/// Run `gpd install opencode --global` using the venv Python.
async fn run_gpd_install(config: &Path) -> Result<(), String> {
    let python = gpd_python();

    tracing::info!("Running gpd install opencode --global --skip-readiness-check");

    let output = timeout(
        Duration::from_secs(60),
        Command::new(&python)
            .args(["-m", "gpd.cli", "install", "opencode", "--global", "--skip-readiness-check"])
            .env("OPENCODE_CONFIG_DIR", config)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "GPD setup is taking too long. Check your internet connection.".to_string())?
    .map_err(|e| format!("Couldn't run GPD setup. ({e})"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("GPD couldn't install its research tools. {stderr}"));
    }

    tracing::info!("gpd install opencode completed");
    Ok(())
}

// ---------------------------------------------------------------------------
// Provider config injection
// ---------------------------------------------------------------------------

fn inject_provider_config(config: &Path) -> Result<(), String> {
    let path = config.join("opencode.json");

    let mut config_val: serde_json::Value = if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Couldn't read GPD's settings file. Try repairing via Settings. ({e})"))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("GPD's settings file is corrupted. Try restarting or repairing from Settings. ({e})"))?
    } else {
        serde_json::json!({})
    };

    if let Some(obj) = config_val.as_object_mut() {
        // Add provider
        let provider = obj.entry("provider").or_insert_with(|| serde_json::json!({}));
        if let Some(provider_obj) = provider.as_object_mut() {
            // NO "env" field here on purpose — previously we had
            // "env": ["GPD_API_KEY"] which told opencode to ONLY read
            // the key from that environment variable. GUI apps on
            // Windows/macOS don't inherit env from .profile / user
            // profile, so GPD.exe launched from the Start menu had
            // an empty GPD_API_KEY and opencode showed "Sign-in
            // failed. Check your access key in Settings." even though
            // the installer had correctly written the key to
            // auth.json. Removing the env field makes opencode fall
            // back to auth.json (which is what we populate from the
            // installer on all platforms). Users who prefer setting
            // the key via env can still do so — opencode honors
            // OPENCODE_API_KEY / provider-specific env overrides
            // regardless of whether env is declared here.
            provider_obj.insert("gpd".to_string(), serde_json::json!({
                "name": "GPD (PSI)",
                "api": LITELLM_URL,
                "models": {
                    "claude-opus-4-6": { "name": "Claude Opus 4.6", "tool_call": true, "reasoning": true, "attachment": true, "temperature": true, "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 1000000, "output": 128000 } },
                    "claude-sonnet-4-6": { "name": "Claude Sonnet 4.6", "tool_call": true, "reasoning": true, "attachment": true, "temperature": true, "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 1000000, "output": 64000 } },
                    "claude-haiku-4-5": { "name": "Claude Haiku 4.5", "tool_call": true, "reasoning": true, "attachment": true, "temperature": true, "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 200000, "output": 64000 } },
                    "gpt-5.5": { "name": "GPT 5.5", "tool_call": true, "reasoning": true, "attachment": true, "temperature": true, "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 1050000, "output": 128000 } },
                    "gpt-5.4": { "name": "GPT 5.4", "tool_call": true, "reasoning": true, "attachment": true, "temperature": true, "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 1050000, "output": 131072 } },
                    "gpt-5.4-mini": { "name": "GPT 5.4 mini", "tool_call": true, "reasoning": true, "attachment": true, "temperature": true, "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 1050000, "output": 131072 } },
                    "gpt-5.4-nano": { "name": "GPT 5.4 nano", "tool_call": true, "reasoning": true, "attachment": true, "temperature": true, "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 1050000, "output": 131072 } },
                    "gpt-5.3-codex": { "name": "GPT 5.3 Codex", "tool_call": true, "attachment": true, "temperature": true, "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 1000000, "output": 32768 } },
                    "gpt-4.1": { "name": "GPT 4.1", "tool_call": true, "attachment": true, "temperature": true, "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 1000000, "output": 32768 } },
                    "gpt-4.1-mini": { "name": "GPT 4.1 mini", "tool_call": true, "attachment": true, "temperature": true, "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 1000000, "output": 32768 } },
                    "o4-mini": { "name": "o4-mini (reasoning)", "tool_call": true, "reasoning": true, "temperature": true, "modalities": { "input": ["text"], "output": ["text"] }, "limit": { "context": 200000, "output": 100000 } },
                    "gemini-3.1-pro-preview": { "name": "Gemini 3.1 Pro", "tool_call": true, "reasoning": true, "attachment": true, "temperature": true, "modalities": { "input": ["text", "image", "pdf", "video", "audio"], "output": ["text"] }, "limit": { "context": 1000000, "output": 65536 } },
                    "gemini-3-flash-preview": { "name": "Gemini 3 Flash", "tool_call": true, "reasoning": true, "attachment": true, "temperature": true, "modalities": { "input": ["text", "image", "pdf", "video", "audio"], "output": ["text"] }, "limit": { "context": 1000000, "output": 65536 } },
                    "gemini-3.1-flash-lite-preview": { "name": "Gemini 3.1 Flash-Lite", "tool_call": true, "attachment": true, "temperature": true, "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }, "limit": { "context": 1000000, "output": 65536 } }
                }
            }));
        }

        // Default model — only on FIRST install. If a model is already
        // persisted (e.g. the user changed it in Settings), preserve it.
        // Previously we unconditionally stomped the user's choice on
        // every run_first_setup() call, which includes repair paths
        // (repair_gpd_venv, marker-missing re-entry at lib.rs:520-529).
        // See Task 3.1 / Decision 0.A in docs/CONFIG_ARCHITECTURE.md.
        if !obj.contains_key("model") {
            obj.insert("model".to_string(), serde_json::json!("gpd/claude-sonnet-4-6"));
        }

        // Only show GPD provider
        obj.insert("enabled_providers".to_string(), serde_json::json!(["gpd"]));

        // Auto-approve all permissions (professors shouldn't see permission prompts)
        obj.insert("permission".to_string(), serde_json::json!("allow"));

        // Overwrite MCP server entries with the correct venv Python path.
        // `gpd install opencode` may write MCP entries pointing to an older
        // Python venv (e.g. ~/.gpd/venv). We always use our managed venv
        // at ~/.config/gpd/.venv/ which has the latest GPD + arxiv packages.
        let python = gpd_python();
        let p = python.to_string_lossy();
        let mcp_json: serde_json::Value = serde_json::json!({
            "gpd-conventions": {"type":"local","command":[&*p,"-m","gpd.mcp.servers.conventions_server"],"enabled":true,"environment":{"LOG_LEVEL":"WARNING"}},
            "gpd-errors": {"type":"local","command":[&*p,"-m","gpd.mcp.servers.errors_mcp"],"enabled":true,"environment":{"LOG_LEVEL":"WARNING"}},
            "gpd-patterns": {"type":"local","command":[&*p,"-m","gpd.mcp.servers.patterns_server"],"enabled":true,"environment":{"LOG_LEVEL":"WARNING"}},
            "gpd-protocols": {"type":"local","command":[&*p,"-m","gpd.mcp.servers.protocols_server"],"enabled":true,"environment":{"LOG_LEVEL":"WARNING"}},
            "gpd-skills": {"type":"local","command":[&*p,"-m","gpd.mcp.servers.skills_server"],"enabled":true,"environment":{"LOG_LEVEL":"WARNING"}},
            "gpd-state": {"type":"local","command":[&*p,"-m","gpd.mcp.servers.state_server"],"enabled":true,"environment":{"LOG_LEVEL":"WARNING"}},
            "gpd-verification": {"type":"local","command":[&*p,"-m","gpd.mcp.servers.verification_server"],"enabled":true,"environment":{"LOG_LEVEL":"WARNING"}},
            "gpd-arxiv": {"type":"local","command":[&*p,"-m","gpd.mcp.servers.arxiv_bridge"],"enabled":true}
        });
        obj.insert("mcp".to_string(), mcp_json);
    }

    let json_str = serde_json::to_string_pretty(&config_val)
        .map_err(|e| format!("Couldn't prepare GPD's settings file. Try restarting the app. ({e})"))?;
    std::fs::write(&path, format!("{json_str}\n"))
        .map_err(|e| format!("Couldn't save GPD's settings. Check disk space and permissions. ({e})"))?;

    tracing::info!(path = %path.display(), "Injected LiteLLM provider config");
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests — run with `cargo test -p opencode-desktop`
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_config_json_is_valid_json() {
        let json = build_config_json();
        let parsed: serde_json::Value =
            serde_json::from_str(&json).expect("build_config_json() produced invalid JSON");

        // Verify top-level structure
        let obj = parsed.as_object().expect("config should be an object");
        assert!(obj.contains_key("provider"), "missing 'provider' key");
        // "model" is deliberately ABSENT — see Task 3.1 / Decision 0.A.
        // OPENCODE_CONFIG_CONTENT is env-tier; if it set "model" it would
        // override the user's saved model on every launch.
        assert!(!obj.contains_key("model"), "'model' must not be in env-tier config");
        assert!(obj.contains_key("enabled_providers"), "missing 'enabled_providers' key");
        assert!(obj.contains_key("mcp"), "missing 'mcp' key");
    }

    #[test]
    fn build_config_json_has_all_16_models() {
        let json = build_config_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let models = parsed["provider"]["gpd"]["models"].as_object().unwrap();
        assert_eq!(models.len(), 14, "expected 14 models, got {}", models.len());

        let expected = [
            "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5",
            "gpt-5.5",
            "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
            "gpt-5.3-codex", "gpt-4.1", "gpt-4.1-mini", "o4-mini",
            "gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.1-flash-lite-preview",
        ];
        for name in &expected {
            assert!(models.contains_key(*name), "missing model: {name}");
        }
    }

    #[test]
    fn build_config_json_has_8_mcp_servers() {
        let json = build_config_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let mcp = parsed["mcp"].as_object().unwrap();
        assert_eq!(mcp.len(), 8, "expected 8 MCP servers, got {}", mcp.len());

        let expected = [
            "gpd-conventions", "gpd-errors", "gpd-patterns", "gpd-protocols",
            "gpd-skills", "gpd-state", "gpd-verification", "gpd-arxiv",
        ];
        for name in &expected {
            assert!(mcp.contains_key(*name), "missing MCP server: {name}");
        }
    }

    #[test]
    fn build_config_json_mcp_paths_use_gpd_venv() {
        let json = build_config_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let mcp = parsed["mcp"].as_object().unwrap();
        let expected_python = gpd_python().to_string_lossy().to_string();

        for (name, cfg) in mcp {
            let cmd = cfg["command"].as_array()
                .unwrap_or_else(|| panic!("MCP server {name} missing 'command' array"));
            let python_path = cmd[0].as_str()
                .unwrap_or_else(|| panic!("MCP server {name} command[0] is not a string"));
            assert_eq!(python_path, expected_python,
                "MCP server {name} uses wrong Python: {python_path}");
        }
    }

    /// Verify that `is_venv_valid` returns false when the expected Python
    /// binary does not exist.  We override the venv lookup by checking that
    /// `gpd_python()` points to a path that does not exist on a clean CI
    /// runner (the real venv is never present in unit-test contexts).
    #[tokio::test]
    async fn is_venv_valid_returns_false_when_binary_missing() {
        // The marker file won't exist in CI either, so this exercises the
        // "binary missing" path. Either way the function must return false.
        let result = is_venv_valid().await;
        // In a CI environment neither the marker nor the binary exist, so the
        // result is definitely false. On a developer machine with a real GPD
        // install the result could be true — but the important invariant is
        // that a *non-existent* binary always produces false.
        let python = gpd_python();
        if !python.exists() {
            assert!(!result, "is_venv_valid should be false when Python binary is absent");
        }
    }

    #[test]
    fn build_config_json_provider_name_is_gpd() {
        let json = build_config_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let name = parsed["provider"]["gpd"]["name"].as_str().unwrap();
        assert_eq!(name, "GPD (PSI)");
        assert!(!json.contains("OpenCode"), "config JSON must not contain 'OpenCode'");
    }

    #[test]
    fn build_config_json_model_values_are_valid() {
        // Verify every model has parseable nested objects (catches format string
        // escaping bugs like {{"input":...}} which produce invalid JSON)
        let json = build_config_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let models = parsed["provider"]["gpd"]["models"].as_object().unwrap();
        for (name, model) in models {
            assert!(model["name"].is_string(), "model {name} missing 'name'");
            assert!(model["limit"].is_object(), "model {name} missing 'limit' object");
            let limit = model["limit"].as_object().unwrap();
            assert!(limit["context"].is_number(), "model {name} limit missing 'context'");
            assert!(limit["output"].is_number(), "model {name} limit missing 'output'");
        }
    }

    #[tokio::test]
    async fn probe_import_returns_true_for_stdlib_module() {
        // Use system python3; if it's missing this test gracefully skips.
        let python = PathBuf::from(if cfg!(windows) { "python" } else { "python3" });
        let py_check = Command::new(&python)
            .args(["--version"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .output()
            .await;
        if py_check.map(|o| !o.status.success()).unwrap_or(true) {
            return;
        }
        assert!(probe_import(&python, "sys").await, "import sys should succeed");
        assert!(
            !probe_import(&python, "definitely_not_a_real_module_xyz").await,
            "import of bogus module should fail"
        );
    }

    #[test]
    fn manifest_parses_as_python_manifest() {
        // Bundled manifest must always be deserializable. Catches accidental
        // schema drift between python-manifest.json and the Rust types.
        let manifest_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("python-manifest.json");
        let bytes = std::fs::read(&manifest_path)
            .expect("python-manifest.json must exist next to Cargo.toml");
        let manifest: PythonManifest =
            serde_json::from_slice(&bytes).expect("python-manifest.json must parse");
        assert!(!manifest.packages.is_empty(), "manifest must list at least one package");
        for pkg in &manifest.packages {
            assert!(!pkg.spec.is_empty(), "every package needs a non-empty spec");
            assert!(!pkg.import_check.is_empty(), "every package needs an import_check");
        }
    }
}
