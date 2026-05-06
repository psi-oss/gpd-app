//! Mirror macOS's `/usr/libexec/path_helper` for GUI-launched processes.
//!
//! Background:
//!   - Shells (Terminal, iTerm, ssh sessions) call `path_helper` from
//!     `/etc/zprofile`, which constructs `PATH` from `/etc/paths` plus
//!     every file under `/etc/paths.d/*` and exports the result.
//!   - macOS GUI apps (.app bundles double-clicked from Finder, or
//!     launched by launchd) inherit `PATH` from launchd, which by default
//!     is `/usr/bin:/bin:/usr/sbin:/sbin` and never runs `path_helper`.
//!
//! Practical consequence: a user with a working MacTeX install
//! (`/Library/TeX/texbin/pdflatex` symlinked from
//! `/etc/paths.d/TeX`) can `which pdflatex` in Terminal but the GPD
//! desktop app cannot find it, even though the binary is sitting right
//! there. Same problem hits MacPorts (`/etc/paths.d/MacPorts`),
//! XQuartz (`/etc/paths.d/40-XQuartz`), and any third-party installer
//! that drops a paths.d file.
//!
//! Augmenting `PATH` at app startup also benefits child processes:
//! when `latexmk` spawns `pdflatex` which spawns `kpsewhich`, those
//! all inherit the corrected `PATH` from us. Fixing `PATH` once at the
//! root saves us from prepending the compiler's directory to every
//! `Command::new` site.
//!
//! On Linux/Windows this module is a no-op — those platforms don't
//! suffer from the same launchd-vs-shell PATH split.

#[cfg(target_os = "macos")]
use std::collections::HashSet;
#[cfg(target_os = "macos")]
use std::ffi::OsString;
#[cfg(target_os = "macos")]
use std::fs;
#[cfg(target_os = "macos")]
use std::path::PathBuf;

/// Augment the current process's `PATH` with everything that macOS's
/// `path_helper` would have added for a shell. Safe to call from
/// non-macOS — it just returns. Call exactly once near the top of
/// `pub fn run()` before any tool detection runs.
pub fn augment_process_path() {
    #[cfg(target_os = "macos")]
    {
        let extras = collect_macos_paths();
        if extras.is_empty() {
            return;
        }
        let existing = std::env::var_os("PATH").unwrap_or_default();
        let mut all: Vec<PathBuf> = std::env::split_paths(&existing).collect();
        let mut seen: HashSet<PathBuf> = all.iter().cloned().collect();
        for entry in extras {
            if seen.insert(entry.clone()) {
                all.push(entry);
            }
        }
        if let Ok(joined) = std::env::join_paths(all) {
            // SAFETY: called exactly once at startup before any threads
            // that read PATH have been spawned. `set_var` is unsafe in
            // multi-threaded contexts — we are not.
            unsafe {
                std::env::set_var("PATH", &joined);
            }
            // Mirror to launchctl scope so deeply-spawned children
            // (sidecars that re-read launchd defaults) see the same
            // PATH. Best-effort — don't fail the app if this errors.
            let _ = launchctl_setenv(&joined);
        }
    }
}

#[cfg(target_os = "macos")]
fn collect_macos_paths() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    // /etc/paths
    push_lines_from(&mut out, "/etc/paths");
    // /etc/paths.d/*
    if let Ok(read) = fs::read_dir("/etc/paths.d") {
        let mut entries: Vec<PathBuf> = read.flatten().map(|e| e.path()).collect();
        // path_helper iterates lexically — match that for parity.
        entries.sort();
        for entry in entries {
            if entry.is_file() {
                if let Some(s) = entry.to_str() {
                    push_lines_from(&mut out, s);
                }
            }
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn push_lines_from(out: &mut Vec<PathBuf>, file: &str) {
    let Ok(contents) = fs::read_to_string(file) else {
        return;
    };
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        out.push(PathBuf::from(trimmed));
    }
}

#[cfg(target_os = "macos")]
fn launchctl_setenv(path: &OsString) -> std::io::Result<()> {
    use std::process::Command;
    Command::new("/bin/launchctl")
        .arg("setenv")
        .arg("PATH")
        .arg(path)
        .status()?;
    Ok(())
}
