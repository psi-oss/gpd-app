// RES-1158: Cmd+F is dispatched from the native Tauri menu (app_menu.rs)
// because the macOS Edit > Find accelerator otherwise eats Cmd+F before
// it reaches the webview's JS keydown handlers. The desktop entry
// (packages/desktop/src/index.tsx) subscribes to the Tauri menu event
// and re-dispatches it as a window CustomEvent so the app code can stay
// platform-agnostic (mirrors the pattern used for deep-link bridging).
//
// The event name MUST stay in sync with the constant in app_menu.rs
// (FIND_IN_CONVERSATION_EVENT) and the desktop entry's listener.
export const SESSION_SEARCH_OPEN_EVENT = "gpd:menu:find-in-conversation"
