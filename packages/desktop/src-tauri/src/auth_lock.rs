// Cross-process advisory file lock that interoperates with the Node-side
// `proper-lockfile` package used by `Auth.set` / `Auth.remove` in
// packages/opencode/src/auth/index.ts. Both sides MUST take the same
// lock or a sidecar write can race a desktop revoke and silently drop a
// provider key.
//
// Protocol (matches proper-lockfile 4.1.2):
//   * Lockfile path = `<target>.lock`, created via `mkdir` (atomic on
//     POSIX + Windows: `std::fs::create_dir` on `EEXIST` returns
//     `AlreadyExists`).
//   * Stale recovery: if the existing lockdir's mtime is older than
//     `stale_ms`, the candidate `rmdir`s it and retries the mkdir once
//     (the "skip stale check to avoid recursion" branch in
//     proper-lockfile/lib/lockfile.js).
//   * Release = `rmdir <target>.lock`.
//   * Path normalisation: matches the Node call site's
//     `realpath: false` setting, i.e. `path.resolve(file)` — absolute
//     path WITHOUT symlink resolution. We deliberately do NOT
//     canonicalize here: Node skips canonicalize (the auth.json file
//     may not exist on first run), and the two sides must agree on the
//     exact same lockfile name. `std::fs::canonicalize` would diverge
//     whenever the target lived under a symlinked $HOME (e.g. macOS
//     `/Users/.../Documents` is sometimes a Firmlink). Using
//     `std::path::absolute` mirrors Node's `path.resolve` exactly.
//
// Tunables come from the Node call site:
//     packages/opencode/src/auth/index.ts (`withAuthLock`):
//         retries: { retries: 20, minTimeout: 50, maxTimeout: 500 },
//         stale:   10_000,
// `retry` library backoff = `min(maxTimeout, minTimeout * factor^n)`
// with default `factor = 2` (no randomize). proper-lockfile clamps
// `stale` to a 2000 ms floor — we do the same so a caller passing a
// shorter window degrades gracefully.
//
// We do NOT implement the periodic mtime "heartbeat" that the Node
// side runs (`updateLock` in lockfile.js). The Rust side holds the
// lock only across a single tmp+rename — well under the 10 s stale
// window — so a heartbeat would be dead code. If a future caller
// needs to hold the lock for longer than `stale_ms`, this module
// must grow a heartbeat thread.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime};

/// Lock options matched to the Node-side `withAuthLock` call site.
///
/// Defaults reproduce
/// `proper-lockfile.lock(file, { retries: { retries: 20, minTimeout: 50,
/// maxTimeout: 500 }, stale: 10_000 })`.
#[derive(Clone, Copy, Debug)]
pub struct LockOptions {
    pub retries: u32,
    pub min_timeout_ms: u64,
    pub max_timeout_ms: u64,
    pub factor: u32,
    /// Lock is considered stale (and may be taken over) once its
    /// mtime is older than this many milliseconds.
    pub stale_ms: u64,
}

impl Default for LockOptions {
    fn default() -> Self {
        Self {
            retries: 20,
            min_timeout_ms: 50,
            max_timeout_ms: 500,
            factor: 2,
            stale_ms: 10_000,
        }
    }
}

/// RAII handle to an acquired directory-lock. Dropping the guard
/// rmdirs the lockfile, releasing the lock — including on panic /
/// early `?`.
pub struct LockGuard {
    lockfile: PathBuf,
    released: bool,
}

impl LockGuard {
    /// Explicitly release the lock and surface any IO error. Useful
    /// when the caller wants to log a release failure; otherwise
    /// `Drop` will still rmdir on a best-effort basis.
    pub fn release(mut self) -> io::Result<()> {
        self.released = true;
        match fs::remove_dir(&self.lockfile) {
            Ok(()) => Ok(()),
            // Already gone: someone (probably a stale-takeover) ate
            // our lockdir while we were running. Surface to caller —
            // they should treat it like a compromised lock.
            Err(e) if e.kind() == io::ErrorKind::NotFound => Err(e),
            Err(e) => Err(e),
        }
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        // Best-effort: NotFound is benign (someone else already took
        // over a stale lock); other errors leave a stuck lockdir
        // that the next acquirer will reap via stale recovery within
        // `stale_ms`. Nothing more we can do from Drop.
        let _ = fs::remove_dir(&self.lockfile);
    }
}

/// Compute the lockfile path from a target. Mirrors
/// `proper-lockfile`'s `getLockFile`:
/// `${path.resolve(file)}.lock`.
fn lockfile_for(target: &Path) -> io::Result<PathBuf> {
    // `std::path::absolute` is the Rust analogue of Node's
    // `path.resolve`: makes the path absolute via the current
    // working directory, normalises `.` / `..` lexically, and does
    // NOT touch the filesystem (unlike `canonicalize`, which would
    // require the target to exist and would resolve symlinks).
    let abs = std::path::absolute(target)?;
    let mut s = abs.into_os_string();
    s.push(".lock");
    Ok(PathBuf::from(s))
}

/// Acquire the lock and run `body`. Releases on every exit path.
pub fn with_lock<F, T, E>(target: &Path, opts: LockOptions, body: F) -> Result<T, LockError<E>>
where
    F: FnOnce() -> Result<T, E>,
{
    let guard = acquire(target, opts).map_err(LockError::Acquire)?;
    let result = body().map_err(LockError::Body)?;
    // Release explicitly so a release error becomes a real error
    // rather than being swallowed by Drop. If release reports the
    // lockdir already gone (NotFound), that's worth surfacing too:
    // the body may have raced a stale-takeover from a peer.
    guard.release().map_err(LockError::Release)?;
    Ok(result)
}

/// Reduce a release `NotFound` to "already released" if the caller
/// doesn't care.
pub fn with_lock_lenient<F, T, E>(
    target: &Path,
    opts: LockOptions,
    body: F,
) -> Result<T, LockError<E>>
where
    F: FnOnce() -> Result<T, E>,
{
    let guard = acquire(target, opts).map_err(LockError::Acquire)?;
    let result = body().map_err(LockError::Body)?;
    match guard.release() {
        Ok(()) => Ok(result),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(result),
        Err(e) => Err(LockError::Release(e)),
    }
}

/// Acquire the lock. Returns a guard that releases on Drop.
pub fn acquire(target: &Path, opts: LockOptions) -> io::Result<LockGuard> {
    let lockfile = lockfile_for(target)?;

    // Match proper-lockfile's `Math.max(stale, 2000)` clamp.
    let stale_ms = opts.stale_ms.max(2000);

    // Try once eagerly, then up to `retries` more times — same shape
    // as the `retry` library: an attempt + N retries.
    for attempt in 0..=opts.retries {
        match try_acquire_once(&lockfile, stale_ms) {
            Ok(()) => {
                return Ok(LockGuard {
                    lockfile,
                    released: false,
                });
            }
            Err(AcquireOnceError::Locked) => {
                if attempt == opts.retries {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        format!(
                            "auth_lock: could not acquire {} after {} attempts",
                            lockfile.display(),
                            attempt + 1
                        ),
                    ));
                }
                let delay = backoff_delay(attempt, &opts);
                thread::sleep(delay);
            }
            Err(AcquireOnceError::Io(e)) => return Err(e),
        }
    }

    // Unreachable: the loop body always returns or sleeps.
    Err(io::Error::other("auth_lock: retry loop exited unexpectedly"))
}

enum AcquireOnceError {
    Locked,
    Io(io::Error),
}

/// One mkdir attempt with stale-recovery. Maps to
/// `acquireLock` in proper-lockfile.
fn try_acquire_once(lockfile: &Path, stale_ms: u64) -> Result<(), AcquireOnceError> {
    match fs::create_dir(lockfile) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            // Existing lock — check staleness.
            let stale = match is_stale(lockfile, stale_ms) {
                Ok(b) => b,
                // Lock vanished between EEXIST and stat: the holder
                // released. Loop and retry the mkdir.
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(AcquireOnceError::Locked),
                Err(e) => return Err(AcquireOnceError::Io(e)),
            };
            if !stale {
                return Err(AcquireOnceError::Locked);
            }
            // Stale: rmdir + single retry (mirrors proper-lockfile's
            // `acquireLock(file, { ...options, stale: 0 }, callback)`
            // recursion-safety branch).
            match fs::remove_dir(lockfile) {
                Ok(()) => {}
                // Someone else reaped it first — fine, fall through
                // to the mkdir.
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(AcquireOnceError::Io(e)),
            }
            match fs::create_dir(lockfile) {
                Ok(()) => Ok(()),
                // Lost the race to another stale-takeover. Caller
                // will back off and retry.
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    Err(AcquireOnceError::Locked)
                }
                Err(e) => Err(AcquireOnceError::Io(e)),
            }
        }
        Err(e) => Err(AcquireOnceError::Io(e)),
    }
}

fn is_stale(lockfile: &Path, stale_ms: u64) -> io::Result<bool> {
    let meta = fs::metadata(lockfile)?;
    let mtime = meta.modified()?;
    let age = SystemTime::now()
        .duration_since(mtime)
        .unwrap_or(Duration::ZERO);
    Ok(age > Duration::from_millis(stale_ms))
}

fn backoff_delay(attempt: u32, opts: &LockOptions) -> Duration {
    // `min(maxTimeout, minTimeout * factor^attempt)` — proper-lockfile
    // forwards into the `retry` library with default `factor: 2`,
    // `randomize: false`.
    let mut ms: u64 = opts.min_timeout_ms;
    for _ in 0..attempt {
        ms = ms.saturating_mul(opts.factor as u64);
        if ms >= opts.max_timeout_ms {
            ms = opts.max_timeout_ms;
            break;
        }
    }
    Duration::from_millis(ms)
}

/// Composite error type so callers can distinguish lock-acquire
/// failures from body errors and from release errors.
#[derive(Debug)]
pub enum LockError<E> {
    Acquire(io::Error),
    Body(E),
    Release(io::Error),
}

impl<E: std::fmt::Display> std::fmt::Display for LockError<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::Acquire(e) => write!(f, "auth_lock acquire: {e}"),
            LockError::Body(e) => write!(f, "auth_lock body: {e}"),
            LockError::Release(e) => write!(f, "auth_lock release: {e}"),
        }
    }
}

impl<E: std::fmt::Debug + std::fmt::Display> std::error::Error for LockError<E> {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::time::Instant;

    /// Per-test scratch dir that cleans up on Drop. Each test gets a
    /// fresh subdir of the OS temp dir to avoid cross-test
    /// contamination.
    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new(tag: &str) -> Self {
            let mut p = std::env::temp_dir();
            let nonce = format!(
                "auth_lock_{}_{}_{}",
                tag,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );
            p.push(nonce);
            fs::create_dir_all(&p).expect("mk tmpdir");
            TmpDir(p)
        }
        fn target(&self) -> PathBuf {
            self.0.join("auth.json")
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fast_opts() -> LockOptions {
        // Tight retry curve so contention tests don't drag.
        LockOptions {
            retries: 50,
            min_timeout_ms: 5,
            max_timeout_ms: 50,
            factor: 2,
            stale_ms: 10_000,
        }
    }

    #[test]
    fn happy_path_lock_release_relock() {
        let tmp = TmpDir::new("happy");
        let target = tmp.target();

        let g = acquire(&target, fast_opts()).expect("first acquire");
        let lf = lockfile_for(&target).unwrap();
        assert!(lf.is_dir(), "lockdir should exist while held");

        g.release().expect("release");
        assert!(!lf.exists(), "lockdir should be gone after release");

        // Re-lock works.
        let g2 = acquire(&target, fast_opts()).expect("second acquire");
        assert!(lf.is_dir());
        drop(g2);
        assert!(!lf.exists(), "Drop should rmdir on best-effort");
    }

    #[test]
    fn contention_b_blocks_until_a_releases() {
        let tmp = TmpDir::new("contend");
        let target = Arc::new(tmp.target());
        let barrier = Arc::new(Barrier::new(2));

        let target_a = Arc::clone(&target);
        let barrier_a = Arc::clone(&barrier);
        let a = thread::spawn(move || {
            let g = acquire(&target_a, fast_opts()).expect("A acquire");
            // Sync with B so B is definitely waiting before A
            // releases.
            barrier_a.wait();
            thread::sleep(Duration::from_millis(120));
            g.release().expect("A release");
        });

        let target_b = Arc::clone(&target);
        let barrier_b = Arc::clone(&barrier);
        let b = thread::spawn(move || {
            barrier_b.wait();
            let start = Instant::now();
            let g = acquire(&target_b, fast_opts()).expect("B acquire eventually");
            let waited = start.elapsed();
            assert!(
                waited >= Duration::from_millis(80),
                "B should have waited for A ({}ms)",
                waited.as_millis()
            );
            drop(g);
        });

        a.join().unwrap();
        b.join().unwrap();
    }

    #[test]
    fn stale_takeover_after_window() {
        let tmp = TmpDir::new("stale");
        let target = tmp.target();
        let lockfile = lockfile_for(&target).unwrap();

        // Simulate a crashed holder by mkdir'ing a lockdir without
        // an owning process.
        fs::create_dir_all(&lockfile).expect("seed crashed lockdir");

        // Force the mtime to look old. Use filetime indirectly:
        // re-create the dir is fine for time checks, but we need
        // `stale_ms` short enough to age out within test runtime.
        // Easier: pass a tiny stale window and sleep past it.
        let opts = LockOptions {
            retries: 20,
            min_timeout_ms: 5,
            max_timeout_ms: 50,
            factor: 2,
            // Floor is 2000ms in `acquire`; sleeping that long is
            // fine for a single integration-style test.
            stale_ms: 100,
        };
        // Wait past the clamped 2 s floor so the seeded lockdir is
        // definitely stale by proper-lockfile's rules.
        thread::sleep(Duration::from_millis(2_100));

        let g = acquire(&target, opts).expect("stale takeover");
        assert!(lockfile.is_dir(), "fresh lockdir present post-takeover");
        drop(g);
        assert!(!lockfile.exists());
    }

    #[test]
    fn lockfile_naming_matches_proper_lockfile() {
        // Sanity check: the lockfile is exactly `<absolute>.lock`,
        // matching proper-lockfile's `getLockFile` output for
        // `realpath: false`.
        let tmp = TmpDir::new("name");
        let target = tmp.target();
        let lf = lockfile_for(&target).unwrap();
        let expected = {
            let mut s = std::path::absolute(&target).unwrap().into_os_string();
            s.push(".lock");
            PathBuf::from(s)
        };
        assert_eq!(lf, expected);
    }
}
