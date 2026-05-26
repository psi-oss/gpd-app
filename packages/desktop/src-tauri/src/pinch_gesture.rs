//! Native trackpad pinch capture for the macOS WKWebView.
//!
//! WebKit on shipping macOS does NOT deliver trackpad pinch gestures to
//! web JS — when `setAllowsMagnification(false)` is set (our chrome-zoom
//! guard), `magnifyWithEvent:` drops the gesture, and `gesturestart/
//! gesturechange/gestureend` only fire under WebKit's `MAC_GESTURE_EVENTS`
//! compile flag (off in user-mode WebKit). The synthesised `wheel`+
//! `ctrlKey` Chrome ships is not a WebKit feature either.
//!
//! To get cursor-anchored pinch zoom on the PDF viewer, we install an
//! `NSMagnificationGestureRecognizer` on the WKWebView's NSView, and
//! forward every state transition to the frontend as a Tauri event with
//! the cumulative magnification and the cursor position (in CSS-px from
//! the view's top-left). The JS PDF viewer subscribes via
//! `@tauri-apps/api/event` and routes each event into the same
//! `applyZoomAroundPoint` math that the buttons use.

#![cfg(target_os = "macos")]

use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{NSGestureRecognizerState, NSMagnificationGestureRecognizer, NSView};
use objc2_foundation::{MainThreadMarker, NSObject, NSObjectProtocol};

/// Payload emitted to JS over the `gpd:pinch` Tauri event.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinchPayload {
    /// One of "began", "changed", "ended", "cancelled". `began` and `ended`
    /// also carry the same `magnification` / `x` / `y` so the JS handler
    /// can build a complete gesture state machine from this single event.
    pub phase: &'static str,
    /// Cumulative magnification delta since the gesture started. A pinch-
    /// open positive (zoom in), pinch-close negative (zoom out). Apply as
    /// `newScale = baseScale * (1.0 + magnification)`.
    pub magnification: f64,
    /// Cursor position in CSS pixels from the view's top-left corner.
    pub x: f64,
    pub y: f64,
}

type Emitter = Box<dyn Fn(PinchPayload) + Send + Sync>;

static EMITTER: OnceLock<Emitter> = OnceLock::new();

/// Register the callback that receives each pinch payload. Called once
/// from `lib.rs` during app setup, after the `AppHandle` is available.
pub fn set_emitter<F>(emitter: F)
where
    F: Fn(PinchPayload) + Send + Sync + 'static,
{
    let _ = EMITTER.set(Box::new(emitter));
}

define_class!(
    // SAFETY: PinchTarget is a thin wrapper around NSObject with no Drop
    // impl and no subclassing requirements.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "GpdPinchTarget"]
    #[ivars = ()]
    struct PinchTarget;

    unsafe impl NSObjectProtocol for PinchTarget {}

    impl PinchTarget {
        #[unsafe(method(handlePinch:))]
        fn handle_pinch(&self, sender: &NSMagnificationGestureRecognizer) {
            // SAFETY: AppKit guarantees these reads on the main thread
            // during the gesture lifecycle.
            let state = unsafe { sender.state() };
            let phase: &'static str = match state {
                NSGestureRecognizerState::Began => "began",
                NSGestureRecognizerState::Changed => "changed",
                NSGestureRecognizerState::Ended => "ended",
                NSGestureRecognizerState::Cancelled => "cancelled",
                _ => return,
            };
            let magnification = unsafe { sender.magnification() } as f64;
            let (x, y) = unsafe {
                let view_opt = sender.view();
                if let Some(view) = view_opt {
                    let p = sender.locationInView(Some(&view));
                    // NSView uses a bottom-up coordinate system by default
                    // (unless `isFlipped` returns YES, which WKWebView's
                    // view DOES). WKWebView is flipped, so locationInView
                    // already gives us top-left origin coordinates — no
                    // y-flip needed. Documented at
                    // https://developer.apple.com/documentation/appkit/nsview/1483532-isflipped
                    (p.x as f64, p.y as f64)
                } else {
                    (0.0, 0.0)
                }
            };
            if let Some(emit) = EMITTER.get() {
                emit(PinchPayload { phase, magnification, x, y });
            }
        }
    }
);

impl PinchTarget {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// Install an `NSMagnificationGestureRecognizer` on the given WKWebView
/// NSView so the user's pinch gestures fire `gpd:pinch` Tauri events.
///
/// Called from `window_customizer.rs` after `setAllowsMagnification(false)`
/// — the two settings are complementary: the disable kills WebKit's
/// built-in chrome-zoom path, the recognizer captures the underlying
/// trackpad gesture and routes it to JS instead.
///
/// # Safety
///
/// `view` must be a valid NSView pointer with a lifetime at least as long
/// as the app's main window.
pub unsafe fn install_on_view(view: &NSView) {
    let Some(mtm) = MainThreadMarker::new() else {
        tracing::warn!("install_on_view called off the main thread; skipping pinch capture");
        return;
    };
    let target = PinchTarget::new(mtm);
    let alloc = mtm.alloc::<NSMagnificationGestureRecognizer>();
    let gesture = unsafe {
        NSMagnificationGestureRecognizer::initWithTarget_action(
            alloc,
            Some(target.as_ref() as &AnyObject),
            Some(sel!(handlePinch:)),
        )
    };
    view.addGestureRecognizer(&gesture);
    // NSGestureRecognizer holds only a weak ref to its target (Apple's
    // target-action convention) — if we drop our Retained<PinchTarget>
    // it deallocates and the gesture stops firing. The target lives for
    // the lifetime of the WKWebView (i.e. the app), so leak the Retained
    // intentionally. Cleaner than a `static Mutex<Vec<Retained<...>>>`
    // because PinchTarget is `MainThreadOnly` (`!Send + !Sync`) and
    // can't go into a regular mutex.
    std::mem::forget(target);
}
