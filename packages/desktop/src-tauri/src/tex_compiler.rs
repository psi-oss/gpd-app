//! TeX compilation + SyncTeX backend for the `.tex` preview feature.
//!
//! This module is the Rust side of Plan B: the user explicitly clicks
//! [Compile] to turn a `.tex` source file into a PDF, and then SyncTeX
//! bidirectional navigation (click-PDF → source line, click-source → PDF
//! coordinates) is enabled on top of that PDF.
//!
//! Compiler resolution order:
//!   1. `pdflatex` on PATH (MacTeX, TeX Live, MiKTeX). Strongly preferred —
//!      most physics users already have a full system TeX distribution, and
//!      its package coverage is complete (TikZ, bibliographies, custom
//!      packages all work out of the box).
//!   2. `tectonic` on PATH (user installed it themselves).
//!   3. `~/.config/gpd/.capabilities/tectonic/bin/tectonic` — the on-demand
//!      install performed by the Dependency Manager panel.
//!   4. If none of the above exist, commands return a structured
//!      `NoCompiler` status so the UI can render a clear CTA.
//!
//! The module intentionally shells out via `tokio::process::Command` rather
//! than linking the Tectonic crate directly. This keeps pdflatex/latexmk
//! parity straightforward and avoids pulling a heavy dep into the desktop
//! binary.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tauri::AppHandle;
use tauri_specta::Event;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

// ---------------------------------------------------------------------------
// Event payload
// ---------------------------------------------------------------------------

/// Progress event emitted while a compile is running so the Build pane can
/// show a spinner with a human-readable phase.
#[derive(
    Clone,
    serde::Serialize,
    serde::Deserialize,
    specta::Type,
    tauri_specta::Event,
)]
pub struct TexCompileProgress {
    /// One of: "starting", "running", "bibbing", "finalizing", "done", "error".
    pub status: String,
    /// 0-100, best-effort. We don't parse log byte counts — this is a coarse
    /// estimate derived from the phase so the progress bar at least moves.
    pub percent: f64,
    /// Short translated-by-frontend message ID or prose describing the phase.
    pub message: String,
}

// ---------------------------------------------------------------------------
// Return shapes
// ---------------------------------------------------------------------------

#[derive(Clone, serde::Serialize, specta::Type, Debug)]
#[serde(rename_all = "snake_case")]
pub enum TexCompileStatus {
    /// Compile exit 0, PDF exists.
    Success,
    /// Compile produced a PDF despite warnings or non-fatal errors.
    SuccessWithWarnings,
    /// Compile failed — no PDF, or PDF missing after run.
    Error,
    /// No compiler found on the system. UI should show install CTA.
    NoCompiler,
    /// User cancelled an in-flight compile.
    Cancelled,
}

#[derive(Clone, serde::Serialize, specta::Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TexDiagnostic {
    pub severity: String, // "error" | "warning"
    pub file: Option<String>,
    pub line: Option<u32>,
    pub message: String,
}

#[derive(Clone, serde::Serialize, specta::Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TexCompileResult {
    pub status: TexCompileStatus,
    /// Absolute path to the produced PDF, if any.
    pub pdf_path: Option<String>,
    /// Absolute path to the `.synctex.gz` file, if any.
    pub synctex_path: Option<String>,
    /// Absolute path to the `.log` file, if any.
    pub log_path: Option<String>,
    /// Which compiler was used.
    pub compiler_kind: Option<String>,
    pub compiler_path: Option<String>,
    /// Wall-clock duration of the compile in milliseconds.
    pub duration_ms: f64,
    pub errors: Vec<TexDiagnostic>,
    pub warnings: Vec<TexDiagnostic>,
    /// The `.tex` file that was actually used as the root.
    pub root_file: String,
    /// The output directory used (under the GPD cache).
    pub out_dir: String,
}

#[derive(Clone, serde::Serialize, specta::Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncTexResult {
    /// For forward (PDF → source): the resolved source file.
    pub file: Option<String>,
    pub line: Option<u32>,
    /// For reverse (source → PDF): page and fractional coordinates (points).
    pub page: Option<u32>,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

#[derive(Clone, serde::Serialize, specta::Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TexLogParseResult {
    pub errors: Vec<TexDiagnostic>,
    pub warnings: Vec<TexDiagnostic>,
    pub raw_log: String,
}

#[derive(Clone, serde::Serialize, specta::Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TexCompilerInfo {
    pub kind: String, // "pdflatex" | "tectonic" | "none"
    pub path: Option<String>,
    /// True iff `latexmk` was also found on PATH — we prefer it when
    /// available because it handles the bib/glossary multi-pass dance.
    pub has_latexmk: bool,
    /// True iff `bibtex` is on PATH (or bundled with the resolved compiler).
    pub has_bibtex: bool,
    /// True iff the `synctex` CLI is on PATH. Without it, we cannot support
    /// bidirectional navigation even if `.synctex.gz` was generated.
    pub has_synctex: bool,
}

// ---------------------------------------------------------------------------
// Cancellation state
// ---------------------------------------------------------------------------

/// Shared cancel handle so a second [Compile] click can abort a prior
/// compile instead of racing it. We track the most-recent child PID; a new
/// compile nulls out the handle to signal the previous task to exit early.
#[derive(Default)]
pub struct TexCompileState {
    current: Mutex<Option<CompileHandle>>,
}

struct CompileHandle {
    generation: u64,
    kill: Arc<tokio::sync::Notify>,
}

impl TexCompileState {
    pub fn new() -> Self {
        Self::default()
    }
}

// ---------------------------------------------------------------------------
// Public commands
// ---------------------------------------------------------------------------

/// Detect the TeX root for a given starting file. Order:
///   1. `% !TEX root = …` magic comment inside `start_file`.
///   2. A `.latexmkrc` in a parent dir with `@default_files = ('foo.tex');`.
///   3. Heuristic: walk parent dirs for a `.tex` file containing
///      `\documentclass`.
///   4. Fallback to `start_file` itself.
#[tauri::command]
#[specta::specta]
pub fn detect_tex_root(start_file: String) -> String {
    let start = PathBuf::from(&start_file);
    if !start.is_absolute() {
        // The frontend always passes absolute paths, but be defensive.
        return start_file;
    }

    // 1. Magic comment at the top of the starting file.
    if let Ok(contents) = std::fs::read_to_string(&start)
        && let Some(root) = magic_root_comment(&contents)
    {
        let resolved = resolve_root_relative(&start, &root);
        if resolved.exists() {
            return resolved.to_string_lossy().to_string();
        }
    }

    // 2. `.latexmkrc` up the tree.
    let mut cursor = start.parent();
    while let Some(dir) = cursor {
        let latexmkrc = dir.join(".latexmkrc");
        if latexmkrc.is_file()
            && let Ok(contents) = std::fs::read_to_string(&latexmkrc)
            && let Some(root) = parse_latexmkrc_default_files(&contents)
        {
            let resolved = dir.join(&root);
            if resolved.exists() {
                return resolved.to_string_lossy().to_string();
            }
        }
        cursor = dir.parent();
    }

    // 3. Heuristic: look in start's directory for a `.tex` with `\documentclass`.
    if let Some(dir) = start.parent()
        && let Some(root) = scan_dir_for_documentclass(dir)
    {
        return root.to_string_lossy().to_string();
    }

    // 4. Fallback.
    start_file
}

/// Resolve which TeX compiler we're going to use. Returns `kind = "none"`
/// (with `path = None`) when nothing is installed. The frontend renders the
/// install CTA in that case.
#[tauri::command]
#[specta::specta]
pub fn detect_tex_compiler() -> TexCompilerInfo {
    let resolved = resolve_tex_compiler();
    let (kind, path) = match resolved {
        Some((k, p)) => (k, Some(p.to_string_lossy().to_string())),
        None => ("none".to_string(), None),
    };
    TexCompilerInfo {
        kind,
        path,
        has_latexmk: which_on_path("latexmk").is_some(),
        has_bibtex: which_on_path("bibtex").is_some(),
        has_synctex: which_on_path("synctex").is_some(),
    }
}

/// Compile a `.tex` file into a PDF inside the GPD cache directory.
///
/// Emits `TexCompileProgress` events as the compile progresses. Returns a
/// structured result even on failure so the UI can render an error panel
/// without crashing the app.
#[tauri::command]
#[specta::specta]
pub async fn compile_tex(
    app: AppHandle,
    state: tauri::State<'_, TexCompileState>,
    project_id: String,
    tex_file: String,
    root_file: Option<String>,
) -> Result<TexCompileResult, String> {
    let start_instant = Instant::now();

    let root = match root_file.clone() {
        Some(r) if !r.is_empty() => r,
        _ => detect_tex_root(tex_file.clone()),
    };

    let root_path = PathBuf::from(&root);
    if !root_path.is_file() {
        return Err(format!("LaTeX source file not found: {root}. Make sure the file exists and hasn't been moved."));
    }

    let Some((compiler_kind, compiler_path)) = resolve_tex_compiler() else {
        return Ok(TexCompileResult {
            status: TexCompileStatus::NoCompiler,
            pdf_path: None,
            synctex_path: None,
            log_path: None,
            compiler_kind: None,
            compiler_path: None,
            duration_ms: start_instant.elapsed().as_millis() as f64,
            errors: Vec::new(),
            warnings: Vec::new(),
            root_file: root,
            out_dir: String::new(),
        });
    };

    // Per-project, per-file cache dir.
    let out_dir = match cache_out_dir(&project_id, &root_path) {
        Ok(p) => p,
        Err(e) => return Err(e),
    };
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("Couldn't create a temporary folder for the LaTeX build. Check disk space. ({e})"))?;

    // Register this compile with the shared state so a second click can
    // cancel it. Use a generation counter so the running task can detect
    // "I have been superseded" without race conditions.
    let kill = Arc::new(tokio::sync::Notify::new());
    let generation = {
        let mut guard = state.current.lock().await;
        // Signal prior compile to die.
        if let Some(prev) = guard.as_ref() {
            prev.kill.notify_waiters();
        }
        let next_gen = guard.as_ref().map(|h| h.generation + 1).unwrap_or(1);
        *guard = Some(CompileHandle {
            generation: next_gen,
            kill: kill.clone(),
        });
        next_gen
    };

    emit_progress(&app, "starting", 5.0, "tex.compile.progress.running");

    let cwd = root_path.parent().unwrap_or(Path::new(".")).to_path_buf();
    let stem = root_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".to_string());

    let has_latexmk = which_on_path("latexmk").is_some();
    let has_bibtex = which_on_path("bibtex").is_some();

    emit_progress(&app, "running", 15.0, "tex.compile.progress.running");

    let run_result = if compiler_kind == "pdflatex" {
        run_pdflatex_pipeline(
            &app,
            &compiler_path,
            &cwd,
            &root_path,
            &out_dir,
            &stem,
            has_latexmk,
            has_bibtex,
            kill.clone(),
        )
        .await
    } else {
        run_tectonic(
            &app,
            &compiler_path,
            &cwd,
            &root_path,
            &out_dir,
            kill.clone(),
        )
        .await
    };

    // If we've been superseded, bail out and return Cancelled. Don't touch
    // state.current because the superseder has already overwritten it.
    {
        let guard = state.current.lock().await;
        if guard.as_ref().map(|h| h.generation) != Some(generation) {
            return Ok(TexCompileResult {
                status: TexCompileStatus::Cancelled,
                pdf_path: None,
                synctex_path: None,
                log_path: None,
                compiler_kind: Some(compiler_kind),
                compiler_path: Some(compiler_path.to_string_lossy().to_string()),
                duration_ms: start_instant.elapsed().as_millis() as f64,
                errors: Vec::new(),
                warnings: Vec::new(),
                root_file: root,
                out_dir: out_dir.to_string_lossy().to_string(),
            });
        }
    }

    emit_progress(&app, "finalizing", 90.0, "tex.compile.progress.finalizing");

    let pdf_path = out_dir.join(format!("{stem}.pdf"));
    let synctex_gz = out_dir.join(format!("{stem}.synctex.gz"));
    let log_path = out_dir.join(format!("{stem}.log"));

    let raw_log = std::fs::read_to_string(&log_path).unwrap_or_default();
    let (errors, warnings) = parse_log_contents(&raw_log);

    let pdf_ok = pdf_path.is_file();
    let status = match (pdf_ok, run_result.exit_ok(), warnings.is_empty()) {
        (true, true, true) => TexCompileStatus::Success,
        (true, _, _) => TexCompileStatus::SuccessWithWarnings,
        (false, _, _) => TexCompileStatus::Error,
    };

    // Clear this compile from state.
    {
        let mut guard = state.current.lock().await;
        if guard.as_ref().map(|h| h.generation) == Some(generation) {
            *guard = None;
        }
    }

    emit_progress(&app, "done", 100.0, "");

    Ok(TexCompileResult {
        status,
        pdf_path: pdf_ok.then(|| pdf_path.to_string_lossy().to_string()),
        synctex_path: synctex_gz
            .is_file()
            .then(|| synctex_gz.to_string_lossy().to_string()),
        log_path: log_path
            .is_file()
            .then(|| log_path.to_string_lossy().to_string()),
        compiler_kind: Some(compiler_kind),
        compiler_path: Some(compiler_path.to_string_lossy().to_string()),
        duration_ms: start_instant.elapsed().as_millis() as f64,
        errors,
        warnings,
        root_file: root,
        out_dir: out_dir.to_string_lossy().to_string(),
    })
}

/// Forward SyncTeX lookup: given `(page, x, y)` on a PDF, return the source
/// file + line. Used when the user clicks in the PDF viewer.
#[tauri::command]
#[specta::specta]
pub async fn synctex_forward(
    synctex_path: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<SyncTexResult, String> {
    let synctex_bin = which_on_path("synctex")
        .ok_or_else(|| "synctex CLI not found on PATH".to_string())?;

    let query = format!("{page}:{x}:{y}:{synctex_path}", synctex_path = synctex_path);
    let output = Command::new(&synctex_bin)
        .arg("view")
        .arg("-i")
        .arg(&query)
        .arg("-o")
        .arg(&synctex_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("Couldn't link PDF to source — SyncTeX isn't available. ({e})"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut file: Option<String> = None;
    let mut line: Option<u32> = None;
    for raw in stdout.lines() {
        if let Some(v) = raw.strip_prefix("Input:") {
            file = Some(v.trim().to_string());
        } else if let Some(v) = raw.strip_prefix("Line:") {
            line = v.trim().parse::<u32>().ok();
        }
    }

    Ok(SyncTexResult {
        file,
        line,
        page: None,
        x: None,
        y: None,
    })
}

/// Reverse SyncTeX lookup: given a `(source_file, line)`, return the PDF
/// page and coordinates. Used when the user clicks a line in the editor.
#[tauri::command]
#[specta::specta]
pub async fn synctex_reverse(
    synctex_path: String,
    source_file: String,
    line: u32,
) -> Result<SyncTexResult, String> {
    let synctex_bin = which_on_path("synctex")
        .ok_or_else(|| "synctex CLI not found on PATH".to_string())?;

    // `synctex edit -o <line>:<column>:<source>` — column 0 means "any".
    let query = format!("{line}:0:{source_file}");
    let output = Command::new(&synctex_bin)
        .arg("edit")
        .arg("-o")
        .arg(&query)
        .arg("-i")
        .arg(&synctex_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("Couldn't link source to PDF — SyncTeX isn't available. ({e})"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut page: Option<u32> = None;
    let mut x: Option<f64> = None;
    let mut y: Option<f64> = None;
    for raw in stdout.lines() {
        if let Some(v) = raw.strip_prefix("Page:") {
            page = v.trim().parse::<u32>().ok();
        } else if let Some(v) = raw.strip_prefix("x:") {
            x = v.trim().parse::<f64>().ok();
        } else if let Some(v) = raw.strip_prefix("y:") {
            y = v.trim().parse::<f64>().ok();
        }
    }

    Ok(SyncTexResult {
        file: None,
        line: None,
        page,
        x,
        y,
    })
}

/// Read a build artifact (PDF, log, synctex) and return it as a base64
/// string so the webview can embed it via a `data:` URL without needing a
/// bespoke asset scope. The path MUST live under the GPD `.tex-builds`
/// cache directory — we refuse arbitrary file reads.
#[tauri::command]
#[specta::specta]
pub fn read_tex_artifact_base64(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let cache_root = gpd_config_dir().join(".tex-builds");
    // Canonicalize both so symlinks / `..` can't escape the cache.
    let canon_path = std::fs::canonicalize(&p)
        .map_err(|e| format!("Couldn't resolve the file path. Try moving the file to a simpler location. ({e})"))?;
    let canon_cache = std::fs::canonicalize(&cache_root)
        .map_err(|e| format!("GPD's LaTeX build folder is missing. Re-render the document. ({e})"))?;
    if !canon_path.starts_with(&canon_cache) {
        return Err(format!(
            "For safety, GPD can only read files inside its LaTeX build folder. ({})",
            canon_path.display()
        ));
    }

    let bytes = std::fs::read(&canon_path)
        .map_err(|e| format!("Couldn't read {}. Check that it exists and hasn't been moved. ({e})", canon_path.display()))?;
    Ok(base64_encode(&bytes))
}

/// Minimal base64 encoder so we don't take a direct dep for a single use.
/// This is the standard `A-Z a-z 0-9 + /` alphabet with `=` padding.
fn base64_encode(input: &[u8]) -> String {
    const ALPHA: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    let mut chunks = input.chunks_exact(3);
    for c in chunks.by_ref() {
        let b = ((c[0] as u32) << 16) | ((c[1] as u32) << 8) | (c[2] as u32);
        out.push(ALPHA[((b >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((b >> 12) & 0x3f) as usize] as char);
        out.push(ALPHA[((b >> 6) & 0x3f) as usize] as char);
        out.push(ALPHA[(b & 0x3f) as usize] as char);
    }
    let rem = chunks.remainder();
    match rem.len() {
        1 => {
            let b = (rem[0] as u32) << 16;
            out.push(ALPHA[((b >> 18) & 0x3f) as usize] as char);
            out.push(ALPHA[((b >> 12) & 0x3f) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let b = ((rem[0] as u32) << 16) | ((rem[1] as u32) << 8);
            out.push(ALPHA[((b >> 18) & 0x3f) as usize] as char);
            out.push(ALPHA[((b >> 12) & 0x3f) as usize] as char);
            out.push(ALPHA[((b >> 6) & 0x3f) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

/// Parse a `.log` file and return structured errors + warnings. Exposed as
/// a standalone command so the UI can re-parse a cached log without
/// re-running the compiler.
#[tauri::command]
#[specta::specta]
pub fn parse_tex_log(log_path: String) -> Result<TexLogParseResult, String> {
    let raw_log = std::fs::read_to_string(&log_path)
        .map_err(|e| format!("Couldn't open the LaTeX error log. Try re-rendering. ({e})"))?;
    let (errors, warnings) = parse_log_contents(&raw_log);
    Ok(TexLogParseResult {
        errors,
        warnings,
        raw_log,
    })
}

// ---------------------------------------------------------------------------
// Compiler resolution
// ---------------------------------------------------------------------------

/// Look for a TeX compiler in the order documented at the top of the file.
pub fn resolve_tex_compiler() -> Option<(String, PathBuf)> {
    if let Some(p) = which_on_path("pdflatex") {
        return Some(("pdflatex".to_string(), p));
    }
    if let Some(p) = which_on_path("tectonic") {
        return Some(("tectonic".to_string(), p));
    }
    let bundled = bundled_tectonic_path();
    if bundled.is_file() {
        return Some(("tectonic".to_string(), bundled));
    }
    None
}

fn bundled_tectonic_path() -> PathBuf {
    let config = gpd_config_dir();
    let bin = if cfg!(windows) {
        "tectonic.exe"
    } else {
        "tectonic"
    };
    config.join(".capabilities/tectonic/bin").join(bin)
}

fn gpd_config_dir() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .map(|h| h.join(".config"))
                .unwrap_or_else(|| PathBuf::from("."))
        })
        .join("gpd")
}

fn which_on_path(cmd: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        format!("{cmd}.exe")
    } else {
        cmd.to_string()
    };
    let check = |dir: &Path| -> Option<PathBuf> {
        let candidate = dir.join(&exe);
        if candidate.is_file() {
            return Some(candidate);
        }
        if !cfg!(windows) {
            let plain = dir.join(cmd);
            if plain.is_file() {
                return Some(plain);
            }
        }
        None
    };
    if let Some(path) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&path) {
            if let Some(found) = check(&entry) {
                return Some(found);
            }
        }
    }
    // macOS GUI apps (Tauri webview, double-clicked .app bundles) inherit
    // the launchd PATH — typically `/usr/bin:/bin:/usr/sbin:/sbin` — and
    // never see shell-added entries like `/Library/TeX/texbin` even when
    // the user has a working MacTeX install. Same problem hits MacPorts
    // (`/opt/local/bin`), Homebrew on Apple Silicon (`/opt/homebrew/bin`),
    // and Windows TeX Live / MiKTeX defaults. Probe known install
    // locations explicitly so MacTeX users don't get a misleading "LaTeX
    // not found" prompt.
    for dir in tex_install_dirs() {
        if let Some(found) = check(&dir) {
            return Some(found);
        }
    }
    None
}

fn tex_install_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/Library/TeX/texbin"));
        dirs.push(PathBuf::from("/usr/local/texlive/texbin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/opt/local/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        // Year-stamped TeX Live installs (e.g. /usr/local/texlive/2024/bin/universal-darwin).
        if let Ok(entries) = std::fs::read_dir("/usr/local/texlive") {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin");
                if let Ok(arches) = std::fs::read_dir(&bin) {
                    for arch in arches.flatten() {
                        dirs.push(arch.path());
                    }
                }
            }
        }
    } else if cfg!(target_os = "linux") {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
        if let Ok(entries) = std::fs::read_dir("/usr/local/texlive") {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin");
                if let Ok(arches) = std::fs::read_dir(&bin) {
                    for arch in arches.flatten() {
                        dirs.push(arch.path());
                    }
                }
            }
        }
    } else if cfg!(target_os = "windows") {
        if let Ok(entries) = std::fs::read_dir("C:\\texlive") {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin").join("windows");
                if bin.is_dir() {
                    dirs.push(bin);
                }
            }
        }
        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join("AppData/Local/Programs/MiKTeX/miktex/bin/x64"));
            dirs.push(home.join("AppData/Local/Programs/MiKTeX/miktex/bin"));
        }
        dirs.push(PathBuf::from("C:\\Program Files\\MiKTeX\\miktex\\bin\\x64"));
        dirs.push(PathBuf::from("C:\\Program Files (x86)\\MiKTeX\\miktex\\bin"));
    }
    dirs
}

// ---------------------------------------------------------------------------
// Cache layout
// ---------------------------------------------------------------------------

fn cache_out_dir(project_id: &str, root: &Path) -> Result<PathBuf, String> {
    let base = gpd_config_dir().join(".tex-builds");
    // Sanitize project_id so a nested path can't escape the cache dir.
    let safe_project = sanitize_segment(project_id);
    let hash = file_hash(root);
    Ok(base.join(safe_project).join(hash))
}

fn sanitize_segment(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Stable cache key for a given TeX root file. We use absolute path
/// composed with mtime so changes to the file invalidate the output dir
/// deterministically without requiring an expensive content hash on every
/// compile.
fn file_hash(root: &Path) -> String {
    let abs = root.to_string_lossy();
    let mtime = std::fs::metadata(root)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);
    // Simple FNV-1a; we don't need cryptographic strength, just a short
    // stable identifier. 16 hex chars is plenty.
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in abs.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    for b in mtime.to_le_bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

// ---------------------------------------------------------------------------
// Running the compiler
// ---------------------------------------------------------------------------

struct RunResult {
    success: bool,
}

impl RunResult {
    fn exit_ok(&self) -> bool {
        self.success
    }
}

async fn run_pdflatex_pipeline(
    app: &AppHandle,
    compiler: &Path,
    cwd: &Path,
    root: &Path,
    out_dir: &Path,
    stem: &str,
    has_latexmk: bool,
    has_bibtex: bool,
    kill: Arc<tokio::sync::Notify>,
) -> RunResult {
    if has_latexmk
        && let Some(latexmk) = which_on_path("latexmk")
    {
        // latexmk handles multi-pass + bibtex automatically when invoked
        // with -pdf. We pipe -pdflatex= to force our resolved binary so an
        // out-of-band pdflatex isn't picked up by accident.
        let mut cmd = Command::new(&latexmk);
        cmd.arg("-pdf")
            .arg("-synctex=1")
            .arg("-interaction=nonstopmode")
            .arg(format!("-outdir={}", out_dir.to_string_lossy()))
            .arg(format!(
                "-pdflatex={} -synctex=1 -interaction=nonstopmode %O %S",
                compiler.to_string_lossy()
            ))
            .arg(root)
            .current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        return run_spawned(app, cmd, kill).await;
    }

    // Plain pdflatex path. Run once, then if `.bib` is referenced and
    // `bibtex` exists, run bibtex + pdflatex twice more.
    let first = run_pdflatex_once(app, compiler, cwd, root, out_dir, kill.clone()).await;
    if !first.success {
        return first;
    }

    let needs_bib = has_bibtex
        && std::fs::read_to_string(root)
            .map(|c| tex_references_bib(&c))
            .unwrap_or(false);
    if !needs_bib {
        return first;
    }

    emit_progress(app, "bibbing", 55.0, "tex.compile.progress.bibbing");
    let bibtex = match which_on_path("bibtex") {
        Some(p) => p,
        None => return first,
    };
    let mut bib = Command::new(&bibtex);
    bib.arg(format!("{stem}.aux"))
        .current_dir(out_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    // Ignore bibtex failure — pdflatex will still print a usable PDF, and
    // the log parser will surface any missing references as warnings.
    let _ = run_spawned(app, bib, kill.clone()).await;

    // Two more passes resolve cross-references after the .bbl is produced.
    let _ = run_pdflatex_once(app, compiler, cwd, root, out_dir, kill.clone()).await;
    run_pdflatex_once(app, compiler, cwd, root, out_dir, kill).await
}

async fn run_pdflatex_once(
    app: &AppHandle,
    compiler: &Path,
    cwd: &Path,
    root: &Path,
    out_dir: &Path,
    kill: Arc<tokio::sync::Notify>,
) -> RunResult {
    let mut cmd = Command::new(compiler);
    cmd.arg("-synctex=1")
        .arg("-interaction=nonstopmode")
        .arg(format!("-output-directory={}", out_dir.to_string_lossy()))
        .arg(root)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    run_spawned(app, cmd, kill).await
}

async fn run_tectonic(
    app: &AppHandle,
    compiler: &Path,
    cwd: &Path,
    root: &Path,
    out_dir: &Path,
    kill: Arc<tokio::sync::Notify>,
) -> RunResult {
    let mut cmd = Command::new(compiler);
    cmd.arg("--outdir")
        .arg(out_dir)
        .arg("--synctex")
        .arg("--keep-logs")
        .arg(root)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    run_spawned(app, cmd, kill).await
}

async fn run_spawned(
    _app: &AppHandle,
    mut cmd: Command,
    kill: Arc<tokio::sync::Notify>,
) -> RunResult {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = match cmd.kill_on_drop(true).spawn() {
        Ok(c) => c,
        Err(_) => return RunResult { success: false },
    };

    // Drain stdout/stderr concurrently so a blocked pipe can't deadlock the
    // child. We don't stream progress byte-by-byte — the log file is the
    // source of truth for diagnostics.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_task = tokio::spawn(async move {
        if let Some(s) = stdout {
            let mut r = BufReader::new(s).lines();
            while let Ok(Some(_)) = r.next_line().await {}
        }
    });
    let err_task = tokio::spawn(async move {
        if let Some(s) = stderr {
            let mut r = BufReader::new(s).lines();
            while let Ok(Some(_)) = r.next_line().await {}
        }
    });

    let success = tokio::select! {
        _ = kill.notified() => {
            let _ = child.start_kill();
            false
        }
        status = child.wait() => {
            status.map(|s| s.success()).unwrap_or(false)
        }
    };

    let _ = out_task.await;
    let _ = err_task.await;

    RunResult { success }
}

fn emit_progress(app: &AppHandle, status: &str, percent: f64, message: &str) {
    let _ = TexCompileProgress {
        status: status.to_string(),
        percent,
        message: message.to_string(),
    }
    .emit(app);
}

// ---------------------------------------------------------------------------
// Root detection helpers
// ---------------------------------------------------------------------------

fn magic_root_comment(contents: &str) -> Option<String> {
    // Only look at the first ~5 lines — the magic comment must be near the
    // top to match the convention used by TeXShop and LaTeX Workshop.
    for line in contents.lines().take(5) {
        let trimmed = line.trim_start();
        if !trimmed.starts_with('%') {
            continue;
        }
        let rest = trimmed.trim_start_matches('%').trim();
        let lower = rest.to_ascii_lowercase();
        if let Some(idx) = lower.find("!tex root") {
            let after = &rest[idx + "!TEX root".len()..];
            let after = after.trim_start_matches([' ', '=', ':']);
            let value = after.trim().trim_matches(|c| c == '"' || c == '\'');
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn resolve_root_relative(start: &Path, root_ref: &str) -> PathBuf {
    let candidate = PathBuf::from(root_ref);
    if candidate.is_absolute() {
        return candidate;
    }
    let base = start.parent().unwrap_or(Path::new("."));
    base.join(candidate)
}

fn parse_latexmkrc_default_files(contents: &str) -> Option<String> {
    // Very small subset — we just look for:
    //   @default_files = ('foo.tex');
    // This is the convention documented in the latexmk manpage.
    for line in contents.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("@default_files") {
            continue;
        }
        if let Some(start) = trimmed.find('\'')
            && let Some(end) = trimmed[start + 1..].find('\'')
        {
            return Some(trimmed[start + 1..start + 1 + end].to_string());
        }
        if let Some(start) = trimmed.find('"')
            && let Some(end) = trimmed[start + 1..].find('"')
        {
            return Some(trimmed[start + 1..start + 1 + end].to_string());
        }
    }
    None
}

fn scan_dir_for_documentclass(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("tex") {
            continue;
        }
        if let Ok(contents) = std::fs::read_to_string(&p)
            && contents.contains("\\documentclass")
        {
            return Some(p);
        }
    }
    None
}

fn tex_references_bib(contents: &str) -> bool {
    contents.contains("\\bibliography{")
        || contents.contains("\\addbibresource")
        || contents.contains("\\cite{")
        || contents.contains("\\nocite{")
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

/// Very lightweight pdflatex log parser. We intentionally do not try to
/// match every corner of the LaTeX log grammar — the goal is to surface
/// the most common "line N in file X" diagnostics so the user can jump to
/// the offending line. Anything we don't recognise ends up in `raw_log`.
fn parse_log_contents(log: &str) -> (Vec<TexDiagnostic>, Vec<TexDiagnostic>) {
    let mut errors: Vec<TexDiagnostic> = Vec::new();
    let mut warnings: Vec<TexDiagnostic> = Vec::new();

    // Track the most recently opened file so `l.NN` lines can be attributed
    // back to a source file. pdflatex logs use `(./path/file.tex` to mark
    // file entry and `)` to close.
    let mut file_stack: Vec<String> = Vec::new();
    let mut current_error: Option<(String, Option<u32>)> = None;

    for raw in log.lines() {
        let line = raw.trim_end();

        // File entry/exit tracking. pdflatex wraps content at 79 columns so
        // some entries won't survive that heuristic, but this covers the
        // common case of errors at the top of a file.
        update_file_stack(line, &mut file_stack);

        if let Some(rest) = line.strip_prefix("! ") {
            // Close any previous error; the next error starts here.
            if let Some((msg, line_num)) = current_error.take() {
                errors.push(TexDiagnostic {
                    severity: "error".to_string(),
                    file: file_stack.last().cloned(),
                    line: line_num,
                    message: msg,
                });
            }
            current_error = Some((rest.to_string(), None));
            continue;
        }

        // pdflatex emits the offending line number on a subsequent line
        // shaped like `l.123 some context here`.
        if let Some(rest) = line.strip_prefix("l.")
            && let Some(space_at) = rest.find(' ').or(Some(rest.len()))
        {
            let num_part = &rest[..space_at];
            if let Ok(n) = num_part.parse::<u32>()
                && let Some((msg, _)) = current_error.as_mut()
            {
                let context = rest[space_at..].trim();
                if !context.is_empty() && !msg.contains(context) {
                    msg.push_str("\n  ");
                    msg.push_str(context);
                }
                let taken = current_error.take().unwrap();
                errors.push(TexDiagnostic {
                    severity: "error".to_string(),
                    file: file_stack.last().cloned(),
                    line: Some(n),
                    message: taken.0,
                });
                continue;
            }
        }

        // Warnings: `LaTeX Warning: …`, `Package xyz Warning: …`,
        // `Overfull \hbox …`.
        if line.starts_with("LaTeX Warning:") || contains_package_warning(line) {
            let line_num = extract_line_number(line);
            warnings.push(TexDiagnostic {
                severity: "warning".to_string(),
                file: file_stack.last().cloned(),
                line: line_num,
                message: line.trim().to_string(),
            });
        } else if line.starts_with("Overfull \\hbox")
            || line.starts_with("Underfull \\hbox")
            || line.starts_with("Overfull \\vbox")
            || line.starts_with("Underfull \\vbox")
        {
            let line_num = extract_hbox_line(line);
            warnings.push(TexDiagnostic {
                severity: "warning".to_string(),
                file: file_stack.last().cloned(),
                line: line_num,
                message: line.trim().to_string(),
            });
        }
    }

    // Flush any trailing error that didn't have an `l.NN` line.
    if let Some((msg, line_num)) = current_error.take() {
        errors.push(TexDiagnostic {
            severity: "error".to_string(),
            file: file_stack.last().cloned(),
            line: line_num,
            message: msg,
        });
    }

    // Cap at 50 each to keep the UI responsive on pathological failures.
    errors.truncate(50);
    warnings.truncate(50);

    // De-dupe near-identical warnings (pdflatex often repeats them).
    let warnings = dedupe_diagnostics(warnings);
    (errors, warnings)
}

fn update_file_stack(line: &str, stack: &mut Vec<String>) {
    let mut chars = line.char_indices().peekable();
    while let Some((idx, c)) = chars.next() {
        match c {
            '(' => {
                // Look ahead for a path-ish token.
                let rest = &line[idx + 1..];
                let end = rest
                    .find(|ch: char| ch == ')' || ch == '(' || ch.is_whitespace())
                    .unwrap_or(rest.len());
                let path = rest[..end].trim().to_string();
                if !path.is_empty() && path.contains('.') {
                    stack.push(path);
                }
            }
            ')' => {
                stack.pop();
            }
            _ => {}
        }
        let _ = chars.peek();
    }
}

fn contains_package_warning(line: &str) -> bool {
    // Matches e.g. "Package hyperref Warning:" or "Class book Warning:".
    let lower = line.to_ascii_lowercase();
    lower.contains("warning:") && (lower.starts_with("package ") || lower.starts_with("class "))
}

fn extract_line_number(line: &str) -> Option<u32> {
    // LaTeX Warning: … on input line 42.
    let marker = "input line ";
    let idx = line.find(marker)?;
    let tail = &line[idx + marker.len()..];
    let end = tail
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(tail.len());
    tail[..end].parse::<u32>().ok()
}

fn extract_hbox_line(line: &str) -> Option<u32> {
    // e.g. "Overfull \hbox … in paragraph at lines 12--15"
    let marker = "at lines ";
    let idx = line.find(marker)?;
    let tail = &line[idx + marker.len()..];
    let end = tail
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(tail.len());
    tail[..end].parse::<u32>().ok()
}

fn dedupe_diagnostics(items: Vec<TexDiagnostic>) -> Vec<TexDiagnostic> {
    let mut seen: HashMap<String, ()> = HashMap::new();
    let mut out: Vec<TexDiagnostic> = Vec::with_capacity(items.len());
    for d in items {
        let key = format!(
            "{}:{}:{}",
            d.file.clone().unwrap_or_default(),
            d.line.unwrap_or(0),
            d.message
        );
        if seen.insert(key, ()).is_none() {
            out.push(d);
        }
    }
    out
}

// Silence unused-import warnings that only apply to test builds.
#[allow(dead_code)]
fn _keep_systemtime(_t: SystemTime) {}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn magic_comment_variants() {
        assert_eq!(
            magic_root_comment("% !TEX root = ../main.tex\nfoo"),
            Some("../main.tex".to_string())
        );
        assert_eq!(
            magic_root_comment("%!TEX root=main.tex\n"),
            Some("main.tex".to_string())
        );
        assert_eq!(
            magic_root_comment("% !tex root: main.tex\n"),
            Some("main.tex".to_string())
        );
        assert_eq!(magic_root_comment("no comment here\n"), None);
    }

    #[test]
    fn latexmkrc_default_files() {
        let rc = "@default_files = ('paper.tex');\n";
        assert_eq!(
            parse_latexmkrc_default_files(rc),
            Some("paper.tex".to_string())
        );
    }

    #[test]
    fn log_parse_error_line() {
        let log = r#"
! Undefined control sequence.
l.42 \badmacro
This is a demo
"#;
        let (errors, warnings) = parse_log_contents(log);
        assert!(warnings.is_empty());
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].line, Some(42));
        assert!(errors[0].message.contains("Undefined"));
    }

    #[test]
    fn log_parse_latex_warning() {
        let log = "LaTeX Warning: Reference `foo' on input line 99 undefined.\n";
        let (errors, warnings) = parse_log_contents(log);
        assert!(errors.is_empty());
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].line, Some(99));
    }

    #[test]
    fn log_parse_overfull_hbox() {
        let log = "Overfull \\hbox (10pt too wide) in paragraph at lines 12--15\n";
        let (_errors, warnings) = parse_log_contents(log);
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].line, Some(12));
    }

    #[test]
    fn sanitize_segment_strips_path_separators() {
        assert_eq!(sanitize_segment("a/b\\c"), "a_b_c");
        assert_eq!(sanitize_segment("proj-1_a"), "proj-1_a");
    }

    #[test]
    fn base64_encode_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn bib_detection() {
        assert!(tex_references_bib(
            "foo \\bibliography{refs} bar"
        ));
        assert!(tex_references_bib("\\cite{foo}"));
        assert!(!tex_references_bib("no bib here"));
    }
}
