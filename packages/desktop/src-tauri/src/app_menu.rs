// RES-1158: custom application menu so Cmd+F can be claimed for in-conversation
// search instead of being eaten by macOS WKWebView's default Edit > Find menu
// accelerator.
//
// Tauri 2's `Menu::default()` produces the system-standard menu, which on
// macOS includes Edit > Find > Find (Cmd+F). That accelerator is consumed by
// the menu before the keystroke ever reaches the webview's JS keydown
// handlers (verified live 2026-05-26: capture-phase document keydown spy
// recorded only `Meta` key events for Cmd+F, the `f` keystroke never
// arrived). To make Cmd+F open the conversation search bar we have to
// (a) NOT install the system Find item, and
// (b) install our own item with the Cmd+F accelerator whose click handler
//     emits a Tauri event that the webview listens for.
//
// We rebuild only the menus we need (App, Edit, View, Window). Standard
// items (Cut/Copy/Paste/Undo/Redo/Quit/etc.) are constructed via Tauri's
// PredefinedMenuItem so they retain their native accelerators + behavior.

use tauri::{
    AppHandle, Emitter, Manager, Runtime,
    menu::{AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, SubmenuBuilder},
};

/// Menu-item ID for our custom "Find in Conversation" entry under Edit.
/// Matches the on_menu_event filter in `lib.rs`.
pub const FIND_IN_CONVERSATION_ID: &str = "gpd.find_in_conversation";

/// Tauri event name emitted to the webview when the user picks Edit > Find
/// in Conversation (or presses its Cmd+F accelerator). The session route
/// listens for this in `session.tsx` and opens the search bar.
pub const FIND_IN_CONVERSATION_EVENT: &str = "gpd://menu/find-in-conversation";

/// Build the application menu. Only macOS strictly needs this customization
/// (it's the platform whose default Edit > Find binding eats Cmd+F before
/// JS sees it), but we install the same menu on all platforms so behavior
/// stays consistent and so Cmd/Ctrl+F always routes through the same path.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = AboutMetadataBuilder::new()
        .name(Some("GPD"))
        .version(Some(app.package_info().version.to_string()))
        .build();

    let app_submenu = SubmenuBuilder::new(app, "GPD")
        .about(Some(about))
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let find_in_conversation = MenuItem::with_id(
        app,
        FIND_IN_CONVERSATION_ID,
        "Find in Conversation",
        true,
        Some("CmdOrCtrl+F"),
    )?;

    // Edit submenu — DELIBERATELY OMITS the system Find/Find Next/etc.
    // submenu so Cmd+F isn't claimed by the menu layer. Our
    // "Find in Conversation" item takes that accelerator instead.
    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&find_in_conversation)
        .build()?;

    let view_submenu = SubmenuBuilder::new(app, "View")
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    let window_submenu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    Menu::with_items(
        app,
        &[&app_submenu, &edit_submenu, &view_submenu, &window_submenu],
    )
}

/// Forward a menu event to the webview. Currently only used for the
/// "Find in Conversation" item; other menu items are predefined and handled
/// by the OS / Tauri runtime directly.
pub fn handle_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    if event.id().as_ref() == FIND_IN_CONVERSATION_ID {
        for window in app.webview_windows().values() {
            let _ = window.emit(FIND_IN_CONVERSATION_EVENT, ());
        }
    }
}
