use tauri::{Manager, Runtime, Window, plugin::Plugin};

pub struct PinchZoomDisablePlugin;

impl Default for PinchZoomDisablePlugin {
    fn default() -> Self {
        Self
    }
}

impl<R: Runtime> Plugin<R> for PinchZoomDisablePlugin {
    fn name(&self) -> &'static str {
        "Does not matter here"
    }

    fn window_created(&mut self, window: Window<R>) {
        let Some(webview_window) = window.get_webview_window(window.label()) else {
            return;
        };

        let _ = webview_window.with_webview(|_webview| {
            #[cfg(target_os = "linux")]
            unsafe {
                use gtk::GestureZoom;
                use gtk::glib::ObjectExt;
                use webkit2gtk::glib::gobject_ffi;

                if let Some(data) = _webview.inner().data::<GestureZoom>("wk-view-zoom-gesture") {
                    gobject_ffi::g_signal_handlers_destroy(data.as_ptr().cast());
                }
            }

            #[cfg(target_os = "macos")]
            unsafe {
                use objc2::rc::Retained;
                use objc2_app_kit::NSView;
                use objc2_web_kit::WKWebView;

                // Get the WKWebView pointer and disable magnification gestures
                // This prevents Cmd+Ctrl+scroll and pinch-to-zoom from changing the zoom level
                let wk_webview: Retained<WKWebView> =
                    Retained::retain(_webview.inner().cast()).unwrap();
                wk_webview.setAllowsMagnification(false);

                // …but with magnification disabled, WebKit also drops the
                // pinch gesture before it reaches JS (gesturestart never
                // fires in user-mode WebKit, and macOS doesn't synthesise
                // wheel+ctrlKey from pinch). Install our own gesture
                // recognizer on the WKWebView's NSView so we can route
                // pinches to the PDF viewer in JS via Tauri events while
                // still keeping the chrome safe from accidental zoom.
                let view: &NSView = wk_webview.as_ref();
                crate::pinch_gesture::install_on_view(view);
            }
        });
    }
}
