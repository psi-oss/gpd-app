mod auth_lock;
mod cli;
mod constants;
mod dependencies;
mod gpd_setup;
mod project_fs;
mod tectonic;
mod tex_compiler;
#[cfg(target_os = "linux")]
pub mod linux_display;
#[cfg(target_os = "linux")]
pub mod linux_windowing;
mod logging;
mod markdown;
mod os;
mod server;
mod window_customizer;
mod windows;

use crate::cli::CommandChild;
use futures::{FutureExt, TryFutureExt};
use std::{
    env,
    future::Future,
    net::TcpListener,
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Listener, Manager, RunEvent, State, ipc::Channel};
#[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_specta::Event;
use tokio::{
    sync::{oneshot, watch},
    time::{sleep, timeout},
};

use crate::cli::{sqlite_migration::SqliteMigrationProgress, sync_cli};
use crate::constants::*;
use crate::windows::{LoadingWindow, MainWindow};

#[derive(Clone, serde::Serialize, specta::Type, Debug)]
struct ServerReadyData {
    url: String,
    username: Option<String>,
    password: Option<String>,
}

#[derive(Clone, Copy, serde::Serialize, specta::Type, Debug)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum InitStep {
    ServerWaiting,
    SqliteWaiting,
    GpdSetup,
    Done,
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
enum WslPathMode {
    Windows,
    Linux,
}

struct InitState {
    current: watch::Receiver<InitStep>,
}

struct ServerState {
    child: Arc<Mutex<Option<CommandChild>>>,
    stopping: Arc<std::sync::atomic::AtomicBool>,
}

/// Resolves with sidecar credentials as soon as the sidecar is spawned (before health check).
struct SidecarReady(futures::future::Shared<oneshot::Receiver<ServerReadyData>>);

#[tauri::command]
#[specta::specta]
fn kill_sidecar(app: AppHandle) {
    let Some(server_state) = app.try_state::<ServerState>() else {
        tracing::info!("Server not running");
        return;
    };

    // Signal the watchdog to stop before killing so it doesn't immediately respawn.
    server_state
        .stopping
        .store(true, std::sync::atomic::Ordering::Relaxed);

    let Some(child) = server_state
        .child
        .lock()
        .expect("Failed to acquire mutex lock")
        .take()
    else {
        tracing::info!("Server state missing");
        return;
    };

    // Synchronous kill first: if the Tokio runtime is shutting down (RunEvent::Exit),
    // the async kill channel may not be processed before all tasks are dropped.
    // force_kill_sync() uses the raw OS PID for a direct SIGKILL.
    child.force_kill_sync();
    let _ = child.kill();

    tracing::info!("Killed server");
}

#[tauri::command]
#[specta::specta]
async fn await_initialization(
    state: State<'_, SidecarReady>,
    init_state: State<'_, InitState>,
    events: Channel<InitStep>,
) -> Result<ServerReadyData, String> {
    let mut rx = init_state.current.clone();

    let stream = async {
        let e = *rx.borrow();
        let _ = events.send(e);

        while rx.changed().await.is_ok() {
            let step = *rx.borrow_and_update();
            let _ = events.send(step);

            if matches!(step, InitStep::Done) {
                break;
            }
        }
    };

    // Wait for sidecar credentials (available immediately after spawn, before health check)
    let data = async {
        state
            .inner()
            .0
            .clone()
            .await
            .map_err(|_| "Failed to get sidecar data".to_string())
    };

    let (result, _) = futures::future::join(data, stream).await;
    result
}

#[tauri::command]
#[specta::specta]
fn check_app_exists(app_name: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        os::windows::check_windows_app(app_name)
    }

    #[cfg(target_os = "macos")]
    {
        check_macos_app(app_name)
    }

    #[cfg(target_os = "linux")]
    {
        check_linux_app(app_name)
    }
}

#[tauri::command]
#[specta::specta]
fn resolve_app_path(app_name: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        os::windows::resolve_windows_app_path(app_name)
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On macOS/Linux, just return the app_name as-is since
        // the opener plugin handles them correctly
        Some(app_name.to_string())
    }
}

#[tauri::command]
#[specta::specta]
fn open_path(_app: AppHandle, path: String, app_name: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let app_name = app_name.map(|v| os::windows::resolve_windows_app_path(&v).unwrap_or(v));
        let is_powershell = app_name.as_ref().is_some_and(|v| {
            std::path::Path::new(v)
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.eq_ignore_ascii_case("powershell")
                        || name.eq_ignore_ascii_case("powershell.exe")
                })
        });

        if is_powershell {
            return os::windows::open_in_powershell(path);
        }

        return tauri_plugin_opener::open_path(path, app_name.as_deref())
            .map_err(|e| format!("Couldn't open that file or folder. Check permissions and that it exists. ({e})"));
    }

    #[cfg(not(target_os = "windows"))]
    tauri_plugin_opener::open_path(path, app_name.as_deref())
        .map_err(|e| format!("Couldn't open that file or folder. Check permissions and that it exists. ({e})"))
}

#[cfg(target_os = "macos")]
fn check_macos_app(app_name: &str) -> bool {
    // Check common installation locations
    let mut app_locations = vec![
        format!("/Applications/{}.app", app_name),
        format!("/System/Applications/{}.app", app_name),
        format!("/System/Library/CoreServices/{}.app", app_name),
    ];

    if let Ok(home) = std::env::var("HOME") {
        app_locations.push(format!("{}/Applications/{}.app", home, app_name));
    }

    for location in app_locations {
        if std::path::Path::new(&location).exists() {
            return true;
        }
    }

    // Also check if command exists in PATH
    Command::new("which")
        .arg(app_name)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum LinuxDisplayBackend {
    Wayland,
    Auto,
}

#[tauri::command]
#[specta::specta]
fn get_display_backend() -> Option<LinuxDisplayBackend> {
    #[cfg(target_os = "linux")]
    {
        let prefer = linux_display::read_wayland().unwrap_or(false);
        return Some(if prefer {
            LinuxDisplayBackend::Wayland
        } else {
            LinuxDisplayBackend::Auto
        });
    }

    #[cfg(not(target_os = "linux"))]
    None
}

#[tauri::command]
#[specta::specta]
fn set_display_backend(_app: AppHandle, _backend: LinuxDisplayBackend) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let prefer = matches!(_backend, LinuxDisplayBackend::Wayland);
        return linux_display::write_wayland(&_app, prefer);
    }

    #[cfg(not(target_os = "linux"))]
    Ok(())
}

#[cfg(target_os = "linux")]
fn check_linux_app(app_name: &str) -> bool {
    return true;
}

/// Returns the bundled THIRD_PARTY_NOTICES.md contents.
///
/// Bundled via `tauri.conf.json` → `bundle.resources`. On macOS/Linux the
/// file ends up inside the .app/.deb resources dir; on Windows it's
/// alongside the .exe after NSIS unpacks it. The Rust tauri API resolves
/// the platform-specific resource dir for us.
#[tauri::command]
#[specta::specta]
fn read_third_party_notices(app: AppHandle) -> Result<String, String> {
    read_bundled_resource(&app, "THIRD_PARTY_NOTICES.md")
}

/// Returns the bundled root LICENSE contents (MIT, PSI + upstream).
#[tauri::command]
#[specta::specta]
fn read_license(app: AppHandle) -> Result<String, String> {
    read_bundled_resource(&app, "LICENSE")
}

/// Exits the app immediately with status 0.
///
/// Used by the TOS re-accept gate when the user declines updated terms.
/// Bypasses window.close() listeners so refusing TOS cannot land the app
/// in a partially-initialised state.
#[tauri::command]
#[specta::specta]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Reads the saved LiteLLM virtual key for the `gpd` provider out of
/// opencode's auth.json, returning `Some(key)` if present.
///
/// Resolves the same path opencode/xdg-basedir does:
///   $XDG_DATA_HOME/opencode/auth.json
///   ↳ else (unix) $HOME/.local/share/opencode/auth.json
///   ↳ else (windows) %APPDATA%/opencode/auth.json
///
/// Used by the TOS version-bump gate so the webview can re-POST
/// acceptance without stashing the raw key in WebKit localStorage —
/// which has unverified cross-OS trust-envelope claims (agent review
/// H3 / H16). auth.json's mode-0600 FS permissions are the only
/// reliable boundary, and reading through this Tauri command keeps
/// the key out of the WebView storage entirely.
///
/// Returns `Err(String)` only on unexpected IO errors; a missing or
/// malformed file yields `Ok(None)` so the webview treats it as "no
/// key saved" and falls back to the welcome screen.
#[tauri::command]
#[specta::specta]
fn read_gpd_key() -> Result<Option<String>, String> {
    let auth_path = opencode_data_dir()?.join("auth.json");
    let bytes = match std::fs::read(&auth_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read auth.json: {e}")),
    };
    let json: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return Ok(None), // treat corrupt as absent, don't crash the gate
    };
    // Shape: { "gpd": { "type": "api", "key": "sk-..." } }
    let key = json
        .get("gpd")
        .and_then(|g| g.get("key"))
        .and_then(|k| k.as_str())
        .map(|s| s.to_string());
    Ok(key)
}

/// Remove the "gpd" entry from auth.json so the sidecar stops reading
/// a stale key on the next provider resolve. Called by the settings /
/// sidebar "Change API Key" flow as an authoritative reset — the
/// sidecar's own `auth.remove` HTTP endpoint is unreliable when the
/// sidecar is mid-dispose or wedged on a request, and the handler used
/// to hang indefinitely waiting on it. Filesystem writes are fast and
/// synchronous, which guarantees the next launch's `read_gpd_key`
/// returns None and SetupGate falls back to the welcome screen.
///
/// Missing file is not an error: the caller's intent is "end state has
/// no gpd key", which is already true. Malformed JSON falls through
/// the same way — we replace it with a clean empty object.
#[tauri::command]
#[specta::specta]
fn remove_gpd_key() -> Result<(), String> {
    let auth_path = opencode_data_dir()?.join("auth.json");
    if let Some(parent) = auth_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }

    // Cross-process advisory lock around the read-modify-write so a
    // sidecar `Auth.set` / `Auth.remove` cannot interleave with this
    // revoke and silently drop a provider key. The sidecar holds the
    // same lock via proper-lockfile in
    // packages/opencode/src/auth/index.ts (`withAuthLock`); the Rust
    // implementation in src/auth_lock.rs reproduces proper-lockfile's
    // mkdir-as-mutex protocol so both sides converge on the same
    // sentinel directory (`<auth.json>.lock`).
    //
    // Lock parameters (retries: 20 @ 50–500 ms exponential backoff,
    // stale: 10 s) match the Node call site exactly. Rust's native
    // flock primitives are deliberately not used: flock is advisory
    // POSIX-only and incompatible with proper-lockfile's directory
    // semantics, so a Rust flock holder would not block a sidecar
    // mkdir and vice versa.
    auth_lock::with_lock(
        &auth_path,
        auth_lock::LockOptions::default(),
        || -> Result<(), String> {
            let bytes = match std::fs::read(&auth_path) {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(e) => return Err(format!("read auth.json: {e}")),
            };
            let mut json: serde_json::Value = match serde_json::from_slice(&bytes) {
                Ok(v) => v,
                Err(_) => serde_json::json!({}),
            };
            if let Some(obj) = json.as_object_mut() {
                obj.remove("gpd");
            } else {
                json = serde_json::json!({});
            }
            let serialized = serde_json::to_vec_pretty(&json)
                .map_err(|e| format!("serialize auth.json: {e}"))?;

            // Atomic tmp+rename so a crash between open and write
            // leaves the PREVIOUS auth.json intact rather than a
            // truncated / 0-byte file. Same contract the Node side
            // holds via writeJsonAtomic
            // (packages/opencode/src/filesystem/index.ts). POSIX
            // rename is atomic; Windows std::fs::rename
            // (fs_rename.rs) uses MoveFileExW(REPLACE_EXISTING)
            // under the hood.
            let tmp_path = auth_path.with_extension(format!("tmp.{}", std::process::id()));
            std::fs::write(&tmp_path, &serialized).map_err(|e| {
                let _ = std::fs::remove_file(&tmp_path);
                format!("write auth.json.tmp: {e}")
            })?;
            std::fs::rename(&tmp_path, &auth_path).map_err(|e| {
                let _ = std::fs::remove_file(&tmp_path);
                format!("rename auth.json.tmp -> auth.json: {e}")
            })?;
            Ok(())
        },
    )
    .map_err(|e| match e {
        auth_lock::LockError::Acquire(io) => format!("acquire auth.json lock: {io}"),
        auth_lock::LockError::Body(msg) => msg,
        auth_lock::LockError::Release(io) => format!("release auth.json lock: {io}"),
    })
}

fn opencode_data_dir() -> Result<std::path::PathBuf, String> {
    if let Ok(p) = std::env::var("XDG_DATA_HOME") {
        return Ok(std::path::PathBuf::from(p).join("opencode"));
    }
    #[cfg(windows)]
    {
        let app = std::env::var("APPDATA")
            .or_else(|_| std::env::var("LOCALAPPDATA"))
            .map_err(|e| format!("APPDATA/LOCALAPPDATA unset: {e}"))?;
        Ok(std::path::PathBuf::from(app).join("opencode"))
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").map_err(|e| format!("HOME unset: {e}"))?;
        Ok(std::path::PathBuf::from(home)
            .join(".local/share")
            .join("opencode"))
    }
}

fn read_bundled_resource(app: &AppHandle, name: &str) -> Result<String, String> {
    let resolver = app.path();
    let path = resolver
        .resolve(name, tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Couldn't resolve bundled resource {name}: {e}"))?;
    std::fs::read_to_string(&path)
        .map_err(|e| format!("Couldn't read bundled {name} at {}: {e}", path.display()))
}

#[tauri::command]
#[specta::specta]
fn wsl_path(path: String, mode: Option<WslPathMode>) -> Result<String, String> {
    if !cfg!(windows) {
        return Ok(path);
    }

    let flag = match mode.unwrap_or(WslPathMode::Linux) {
        WslPathMode::Windows => "-w",
        WslPathMode::Linux => "-u",
    };

    // Previously the `~`-prefixed branch built a string and passed it
    // through `sh -lc` so the shell would expand `$HOME`. That is a
    // shell-injection sink: a path like `~$(calc.exe)` reaches
    // `sh -lc "wslpath -u \"$HOME$(calc.exe)\""` and the command
    // substitution runs before wslpath sees anything. Only `"` was
    // escaped, so `$()`, backticks, `;`, `|`, `&&`, newlines were all
    // exploitable from any caller that can reach `commands.wslPath`
    // (the webview). Now: reject shell metachars up front, resolve
    // `~` to the user's home via `wsl -e sh -c 'printf %s "$HOME"'`
    // (a command that produces a value, separate from the path
    // interpolation), and invoke `wslpath` with the concatenated
    // absolute path as a single argv slot. No sh -lc on the hot path.
    let safe_tail: String = if path.starts_with('~') {
        let tail = path.strip_prefix('~').unwrap_or("");
        if tail.chars().any(|c| matches!(c, '$' | '`' | ';' | '|' | '&' | '>' | '<' | '\n' | '\r' | '\\' | '"' | '\''))
        {
            return Err("Path contains shell metacharacters; use an absolute path instead.".to_string());
        }
        let home_out = Command::new("wsl")
            .args(["-e", "sh", "-c", "printf %s \"$HOME\""])
            .output()
            .map_err(|e| format!("Couldn't translate the file path for WSL. Try a simpler path. ({e})"))?;
        if !home_out.status.success() {
            return Err("Couldn't resolve $HOME in WSL. Try an absolute path instead.".to_string());
        }
        let home = String::from_utf8_lossy(&home_out.stdout).trim().to_string();
        format!("{home}{tail}")
    } else {
        path
    };

    let output = Command::new("wsl")
        .args(["-e", "wslpath", flag, &safe_tail])
        .output()
        .map_err(|e| format!("Couldn't translate the file path for WSL. Try a simpler path. ({e})"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err("Couldn't translate the file path for WSL. Try a simpler path.".to_string());
        }
        return Err(stderr);
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let specta_builder = make_specta_builder();

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    export_types(&specta_builder);

    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    let _ = std::process::Command::new("killall")
        .arg("opencode-cli")
        .output();

    let tauri_builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus existing window when another instance is launched
            if let Some(window) = app.get_webview_window(MainWindow::LABEL) {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(window_state_flags())
                .with_denylist(&[LoadingWindow::LABEL])
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(crate::window_customizer::PinchZoomDisablePlugin)
        .plugin(tauri_plugin_decorum::init());

    // tauri-plugin-mcp opens an unauthenticated local socket and exposes
    // `execute_js` as an arbitrary-JS escape hatch. Per the plugin's own
    // README it MUST be gated behind `debug_assertions`; shipping it in
    // release builds would expose every user to a persistent unauthenticated
    // local RCE surface.
    #[cfg(debug_assertions)]
    let tauri_builder = tauri_builder.plugin(tauri_plugin_mcp::init_with_config(
        tauri_plugin_mcp::PluginConfig::new("GPD".to_string()).start_socket_server(true),
    ));

    let mut builder = tauri_builder
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            let handle = app.handle().clone();

            let log_dir = app
                .path()
                .app_log_dir()
                .expect("failed to resolve app log dir");
            // Hold the guard in managed state so it lives for the app's lifetime,
            // ensuring all buffered logs are flushed on shutdown.
            handle.manage(logging::init(&log_dir));
            // Shared cancel-aware TeX compile state so a second Compile
            // click aborts an in-flight compile instead of racing it.
            handle.manage(tex_compiler::TexCompileState::new());

            specta_builder.mount_events(&handle);
            tauri::async_runtime::spawn(initialize(handle));

            Ok(())
        });

    if UPDATER_ENABLED {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                tracing::info!("Received Exit");

                kill_sidecar(app.clone());
            }
        });
}

fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        // Then register them (separated by a comma)
        .commands(tauri_specta::collect_commands![
            kill_sidecar,
            read_third_party_notices,
            read_license,
            quit_app,
            read_gpd_key,
            remove_gpd_key,
            cli::install_cli,
            await_initialization,
            server::get_default_server_url,
            server::set_default_server_url,
            server::get_wsl_config,
            server::set_wsl_config,
            get_display_backend,
            set_display_backend,
            markdown::parse_markdown_command,
            check_app_exists,
            wsl_path,
            resolve_app_path,
            open_path,
            dependencies::install_git_macos,
            dependencies::install_git_windows,
            dependencies::linux_install_hint,
            gpd_setup::repair_gpd_venv,
            tectonic::install_tectonic,
            tex_compiler::detect_tex_compiler,
            tex_compiler::detect_tex_root,
            tex_compiler::compile_tex,
            tex_compiler::synctex_forward,
            tex_compiler::synctex_reverse,
            tex_compiler::parse_tex_log,
            tex_compiler::read_tex_artifact_base64,
            project_fs::create_project_directory,
            project_fs::check_project_accessible,
            project_fs::canonicalize_project_path
        ])
        .events(tauri_specta::collect_events![
            LoadingWindowComplete,
            SqliteMigrationProgress,
            GpdFirstRunComplete,
            tectonic::TectonicDownloadProgress,
            tex_compiler::TexCompileProgress
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
}

fn export_types(builder: &tauri_specta::Builder<tauri::Wry>) {
    builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/bindings.ts",
        )
        .expect("Failed to export typescript bindings");
}

#[cfg(test)]
#[test]
fn test_export_types() {
    let builder = make_specta_builder();
    export_types(&builder);
}

#[derive(tauri_specta::Event, serde::Deserialize, specta::Type)]
struct LoadingWindowComplete;

/// Emitted once, after a successful GPD first-run setup, so the frontend can
/// show an informational toast about where files were installed.
#[derive(Clone, tauri_specta::Event, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct GpdFirstRunComplete;

async fn initialize(app: AppHandle) {
    tracing::info!("Initializing app");

    let (init_tx, init_rx) = watch::channel(InitStep::ServerWaiting);

    setup_app(&app, init_rx);
    spawn_cli_sync_task(app.clone());

    // Spawn sidecar immediately - credentials are known before health check
    let port = get_sidecar_port();
    let hostname = "127.0.0.1";
    let url = format!("http://{hostname}:{port}");
    let password = uuid::Uuid::new_v4().to_string();

    // Use GPD-specific config directory to avoid colliding with personal OpenCode installs
    let gpd_config = gpd_setup::config_dir();

    // Decide whether first-run setup is needed:
    //   • Marker missing                → fresh install, run setup.
    //   • Marker present + venv invalid → venv broken after upgrade or partial
    //                                     delete; re-run setup (idempotent).
    //   • Marker present + venv valid   → skip setup entirely.
    let venv_valid = gpd_setup::is_venv_valid().await;
    let marker_exists = gpd_setup::is_initialized();
    let needs_gpd_setup = if marker_exists && !venv_valid {
        tracing::warn!("GPD venv appears broken; re-running setup");
        true
    } else if !marker_exists {
        tracing::info!("GPD first-run detected — will run setup after health check");
        true
    } else {
        false
    };

    tracing::info!("Spawning sidecar on {url}");
    let gpd_config_str = gpd_config.to_string_lossy().to_string();

    // Prepend GPD bin and venv bin to PATH so the agent can find `uv` (for
    // per-project venv management) and the GPD venv Python.
    //
    // Path note: the venv lives at `~/.gpd/venv/` (no leading dot), to
    // match the CLI installer's layout (`install-gpd/install` →
    // `GPD_VENV_DIR="$GPD_HOME/venv"`) and gpd_setup::gpd_venv_dir().
    // An earlier `~/.gpd/.venv/bin` here was a typo from when the dir
    // briefly lived under `~/.config/gpd/.venv/`; sidecar/agent
    // subprocesses that resolved `python` or `uv` via PATH silently
    // missed the bundled interpreter and fell through to system
    // python or 127.
    let gpd_bin = gpd_config.join("bin");
    let gpd_venv_bin = gpd_config.join("venv").join("bin");
    let current_path = std::env::var("PATH").unwrap_or_default();
    let augmented_path = format!(
        "{}:{}:{}",
        gpd_bin.to_string_lossy(),
        gpd_venv_bin.to_string_lossy(),
        current_path,
    );

    // Stable env vars captured for both the initial launch and watchdog respawn.
    // The password is NOT included here — it is regenerated on each spawn.
    let stable_env: Vec<(String, String)> = vec![
        ("OPENCODE_CONFIG_DIR".to_string(), gpd_config_str),
        ("OPENCODE_CONFIG_CONTENT".to_string(), gpd_setup::build_config_json()),
        ("PATH".to_string(), augmented_path),
        // GPD uses a fully self-contained provider definition via OPENCODE_CONFIG_CONTENT
        // with enabled_providers: ["gpd"], so the models.dev network fetch is wasted work.
        // Skipping it eliminates several seconds of startup latency on cold cache.
        ("OPENCODE_DISABLE_MODELS_FETCH".to_string(), "1".to_string()),
        // GPD: session sharing is hidden in the UI and no-op'd at the runtime layer
        // until we ship a PSI-hosted share service. Upstream's default share
        // endpoint is opncd.ai (anomalyco-operated); we don't want researcher
        // sessions flowing through that. Hard-disable at the sidecar so
        // programmatic invocations (SDK calls, slash commands, deep links)
        // all no-op cleanly.
        ("OPENCODE_DISABLE_SHARE".to_string(), "1".to_string()),
        // GPD session logging. Activates the GpdLogger bus-subscriber
        // which POSTs gzipped NDJSON flushes to LiteLLM's /gpd/log route.
        // Auth flows through the user's existing virtual key in auth.json;
        // we never ship a GCS service-account key on the desktop.
        // The proxy on Railway forwards writes to gs://gpd-desktop-logs.
        ("OPENCODE_GPD_LOGS_ENABLED".to_string(), "1".to_string()),
    ];

    let (child, health_check) = {
        let env_refs: Vec<(&str, String)> = stable_env
            .iter()
            .map(|(k, v)| (k.as_str(), v.clone()))
            .collect();
        server::spawn_local_server(
            app.clone(),
            hostname.to_string(),
            port,
            password.clone(),
            &env_refs,
        )
    };

    // Create the Arc upfront so the watchdog can also hold a reference.
    let server_child_arc: Arc<Mutex<Option<CommandChild>>> = Arc::new(Mutex::new(Some(child)));
    let stopping = Arc::new(std::sync::atomic::AtomicBool::new(false));

    // Make sidecar credentials available immediately (before health check completes)
    let (ready_tx, ready_rx) = oneshot::channel();
    let _ = ready_tx.send(ServerReadyData {
        url: url.clone(),
        username: Some("opencode".to_string()),
        password: Some(password),
    });
    app.manage(SidecarReady(ready_rx.shared()));
    app.manage(ServerState {
        child: Arc::clone(&server_child_arc),
        stopping: Arc::clone(&stopping),
    });

    // Watchdog: detect unexpected sidecar death and respawn automatically.
    //
    // Debug-only. In release builds a dead sidecar is an unrecoverable
    // error from the webview's perspective — the cached base URL and
    // basic-auth password are both stale after respawn, and we have no
    // frontend channel to push new credentials, so silent autoheal would
    // leave users staring at "failed to fetch" forever. Instead, release
    // builds let the sidecar die loudly so the existing error surface
    // runs. The test harness (which only runs against debug builds) still
    // exercises sidecar respawn via tests/lifecycle/test_sidecar_respawn.py.
    #[cfg(debug_assertions)]
    {
        let watchdog_app = app.clone();
        let watchdog_child = Arc::clone(&server_child_arc);
        let watchdog_stopping = Arc::clone(&stopping);
        tokio::spawn(async move {
            // Give the initial sidecar time to start before monitoring begins.
            tokio::time::sleep(Duration::from_secs(10)).await;
            // Exponential backoff across consecutive respawn failures.
            // Starts at 1s, doubles on each unhealthy respawn, caps at 60s,
            // resets on a healthy respawn. Prevents a sidecar that
            // crashloops at startup from thrashing port allocation and
            // flooding logs.
            let mut backoff = Duration::from_secs(1);
            let backoff_cap = Duration::from_secs(60);
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if watchdog_stopping.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                let alive = watchdog_child
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|c| c.is_alive())
                    .unwrap_or(false);
                if alive {
                    continue;
                }

                tracing::warn!(?backoff, "Sidecar died unexpectedly, backing off before respawn");
                tokio::time::sleep(backoff).await;
                if watchdog_stopping.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }

                let new_port = get_sidecar_port();
                let new_password = uuid::Uuid::new_v4().to_string();
                let env_refs: Vec<(&str, String)> = stable_env
                    .iter()
                    .map(|(k, v)| (k.as_str(), v.clone()))
                    .collect();
                let (new_child, health_check) = server::spawn_local_server(
                    watchdog_app.clone(),
                    "127.0.0.1".to_string(),
                    new_port,
                    new_password,
                    &env_refs,
                );
                *watchdog_child.lock().unwrap() = Some(new_child);

                // Await the health check before declaring the respawn
                // successful. If the new sidecar fails to become healthy,
                // the next loop iteration will observe `is_alive() == false`
                // again and double the backoff — preventing a tight
                // crashloop on a genuinely broken binary.
                match health_check.0.await {
                    Ok(Ok(())) => {
                        tracing::info!(new_port, "Sidecar respawned and healthy");
                        backoff = Duration::from_secs(1);
                    }
                    Ok(Err(err)) => {
                        tracing::error!(%err, "Respawned sidecar failed health check");
                        backoff = (backoff * 2).min(backoff_cap);
                    }
                    Err(err) => {
                        tracing::error!(%err, "Respawned sidecar health check task panicked");
                        backoff = (backoff * 2).min(backoff_cap);
                    }
                }
            }
        });
    }

    let loading_window_complete = event_once_fut::<LoadingWindowComplete>(&app);

    // SQLite migration handling:
    // We only do this if the sqlite db doesn't exist, and we're expecting the sidecar to create it.
    // A separate loading window is shown for long migrations.
    let needs_migration = !sqlite_file_exists();
    let sqlite_done = needs_migration.then(|| {
        tracing::info!(
            path = %opencode_db_path().expect("failed to get db path").display(),
            "Sqlite file not found, waiting for it to be generated"
        );

        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done_tx = Arc::new(Mutex::new(Some(done_tx)));

        let init_tx = init_tx.clone();
        let id = SqliteMigrationProgress::listen(&app, move |e| {
            let _ = init_tx.send(InitStep::SqliteWaiting);

            if matches!(e.payload, SqliteMigrationProgress::Done)
                && let Some(done_tx) = done_tx.lock().unwrap().take()
            {
                let _ = done_tx.send(());
            }
        });

        let app = app.clone();
        tokio::spawn(done_rx.map(async move |_| {
            app.unlisten(id);
        }))
    });

    // The loading task waits for SQLite migration (if needed) then for the sidecar health check.
    // This is only used to drive the loading window progress - the main window is shown immediately.
    let loading_task = tokio::spawn({
        let app_clone = app.clone();
        let init_tx_clone = init_tx.clone();
        async move {
            if let Some(sqlite_done_rx) = sqlite_done {
                let _ = sqlite_done_rx.await;
            }

            // Wait for sidecar to become healthy (for loading window progress)
            let res = timeout(Duration::from_secs(30), health_check.0).await;
            match res {
                Ok(Ok(Ok(()))) => tracing::info!("Sidecar health check OK"),
                Ok(Ok(Err(e))) => tracing::error!("Sidecar health check failed: {e}"),
                Ok(Err(e)) => tracing::error!("Sidecar health check task failed: {e}"),
                Err(_) => tracing::error!("Sidecar health check timed out"),
            }

            // GPD first-run setup (after server is healthy)
            if needs_gpd_setup {
                let _ = init_tx_clone.send(InitStep::GpdSetup);
                match gpd_setup::run_first_setup(app_clone.clone()).await {
                    Ok(()) => {
                        tracing::info!("GPD first-run setup completed");
                        // Notify the frontend so it can show an informational toast
                        // about where GPD installed its files.
                        let _ = GpdFirstRunComplete.emit(&app_clone);
                    }
                    Err(e) => tracing::error!("GPD first-run setup failed: {e}"),
                    // Non-fatal: marker not written on failure, retries next launch
                }
            }

            tracing::info!("Loading task finished");
        }
    })
    .map_err(|_| ())
    .shared();

    // Show loading window for SQLite migrations if they take >1s
    let loading_window = if needs_migration
        && timeout(Duration::from_secs(1), loading_task.clone())
            .await
            .is_err()
    {
        tracing::debug!("Loading task timed out, showing loading window");
        let loading_window = LoadingWindow::create(&app).expect("Failed to create loading window");
        sleep(Duration::from_secs(1)).await;
        Some(loading_window)
    } else {
        None
    };

    // Create main window immediately - the web app handles its own loading/health gate
    MainWindow::create(&app).expect("Failed to create main window");

    let _ = loading_task.await;

    tracing::info!("Loading done, completing initialisation");
    let _ = init_tx.send(InitStep::Done);

    if loading_window.is_some() {
        loading_window_complete.await;
        tracing::info!("Loading window completed");
    }

    if let Some(loading_window) = loading_window {
        let _ = loading_window.close();
    }
}

fn setup_app(app: &tauri::AppHandle, init_rx: watch::Receiver<InitStep>) {
    #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
    app.deep_link().register_all().ok();

    app.manage(InitState { current: init_rx });
}

fn spawn_cli_sync_task(app: AppHandle) {
    tokio::spawn(async move {
        if let Err(e) = sync_cli(app) {
            tracing::error!("Failed to sync CLI: {e}");
        }
    });
}


fn get_sidecar_port() -> u32 {
    option_env!("OPENCODE_PORT")
        .map(|s| s.to_string())
        .or_else(|| std::env::var("OPENCODE_PORT").ok())
        .and_then(|port_str| port_str.parse().ok())
        .unwrap_or_else(|| {
            TcpListener::bind("127.0.0.1:0")
                .expect("Failed to bind to find free port")
                .local_addr()
                .expect("Failed to get local address")
                .port()
        }) as u32
}

fn sqlite_file_exists() -> bool {
    let Ok(path) = opencode_db_path() else {
        return true;
    };

    path.exists()
}

fn opencode_db_path() -> Result<PathBuf, &'static str> {
    let xdg_data_home = env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty());

    let data_home = match xdg_data_home {
        Some(v) => PathBuf::from(v),
        None => {
            let home = dirs::home_dir().ok_or("cannot determine home directory")?;
            home.join(".local").join("share")
        }
    };

    Ok(data_home.join("opencode").join("opencode.db"))
}

// Creates a `once` listener for the specified event and returns a future that resolves
// when the listener is fired.
// Since the future creation and awaiting can be done separately, it's possible to create the listener
// synchronously before doing something, then awaiting afterwards.
fn event_once_fut<T: tauri_specta::Event + serde::de::DeserializeOwned>(
    app: &AppHandle,
) -> impl Future<Output = ()> {
    let (tx, rx) = oneshot::channel();
    T::once(app, |_| {
        let _ = tx.send(());
    });
    async {
        let _ = rx.await;
    }
}
