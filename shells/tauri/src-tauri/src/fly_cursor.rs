//! Fly's cursor lock on the macOS desktop (`app/src/viewport/flyCursorLock.ts`,
//! docs/design/fly-navigation.md §10 "Cursor lock").
//!
//! WKWebView denies the Pointer Lock API unless its embedder implements a
//! private WebKit delegate (`_webViewDidRequestPointerLock:completionHandler:`
//! in WebKit's `UIDelegate.mm`; without it every request rejects with
//! "requires the window to have focus"), so the shell locks the cursor
//! itself: warp it to the screen point the page asks for
//! (`CGWarpMouseCursorPosition`), freeze it (tao's `set_cursor_grab`, which
//! is `CGAssociateMouseAndMouseCursorPosition(false)`) and hide it
//! (`NSCursor hide`). The webview keeps receiving the HID deltas
//! as `movementX`/`movementY` — verified against a bare WKWebView — which is
//! all the page reads while locked. Unlocking reverses both and the cursor
//! reappears where it was frozen. Every other platform answers `false` and
//! the page uses the standard API (WebView2 and WebKitGTK grant it).
//!
//! The hide is app-global and counted by AppKit, so it is tracked here and
//! balanced exactly once. A window losing focus or being destroyed while
//! locked unlocks (`unlock_if_locked`, from the window-event hook), or the
//! cursor would stay hidden and frozen over whatever app comes to the
//! front — the page releases on blur too, and the two are idempotent.

#[cfg(target_os = "macos")]
use std::sync::Mutex;

/// Only the macOS lock reads these; elsewhere the state is an empty
/// placeholder so `main.rs` can manage it on every platform.
#[derive(Default)]
pub struct FlyCursorState {
    #[cfg(target_os = "macos")]
    hidden: Mutex<bool>,
    /// Lock and unlock run strictly one at a time, so two concurrent
    /// commands from a quick tap can never apply unlock-then-lock and
    /// leave the cursor frozen and hidden (review finding). The page
    /// serializes its calls too; this guards the command itself.
    #[cfg(target_os = "macos")]
    serial: tauri::async_runtime::Mutex<()>,
}

/// `locked: true` warps the cursor to `(x, y)` (screen CSS pixels, the
/// page's `screenX`/`screenY` frame), freezes and hides it; `false`
/// unfreezes and shows it. Returns whether this shell handles the lock at
/// all. `async` so the one-at-a-time mutex can be awaited.
#[tauri::command]
pub async fn set_fly_cursor_lock(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    locked: bool,
    x: f64,
    y: f64,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let state = app.state::<FlyCursorState>();
        let _one_at_a_time = state.serial.lock().await;
        platform::set(&app, &window, locked, x, y).map(|()| true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, locked, x, y);
        Ok(false)
    }
}

/// Window-event hook (focus lost, destroyed): give the cursor back if a
/// flight still holds it.
pub fn unlock_if_locked(app: &tauri::AppHandle, window: &tauri::Window) {
    #[cfg(target_os = "macos")]
    {
        let _ = platform::unlock_if_locked(app, window);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window);
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::FlyCursorState;
    use objc2_app_kit::NSCursor;
    use tauri::Manager;

    #[repr(C)]
    struct CGPointFfi {
        x: f64,
        y: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWarpMouseCursorPosition(new_cursor_position: CGPointFfi) -> i32;
    }

    pub fn set(
        app: &tauri::AppHandle,
        window: &tauri::WebviewWindow,
        locked: bool,
        x: f64,
        y: f64,
    ) -> Result<(), String> {
        if locked {
            // Warp straight through CoreGraphics in the SCREEN coordinates
            // the page supplies (`screenX`/`screenY`, CSS pixels from the
            // primary display's top-left — the same frame CG uses, and the
            // only one that already accounts for WebKit's own top content
            // inset under the title bar, which no view geometry exposes:
            // live finding, the warp through window coordinates landed a
            // title bar too high). Then the grab; a step that fails after
            // the grab rolls it back, so a failed lock never leaves the
            // cursor frozen (review finding).
            // SAFETY: a plain CoreGraphics call with a by-value point.
            let err = unsafe { CGWarpMouseCursorPosition(CGPointFfi { x, y }) };
            if err != 0 {
                return Err(format!("CGWarpMouseCursorPosition failed ({err})"));
            }
            window.set_cursor_grab(true).map_err(|e| e.to_string())?;
            if let Err(e) = set_hidden(app, true) {
                let _ = window.set_cursor_grab(false);
                return Err(e);
            }
            Ok(())
        } else {
            // Both steps regardless of the other's outcome: a failed
            // unfreeze must not leave the cursor hidden, nor the reverse.
            let grab = window.set_cursor_grab(false).map_err(|e| e.to_string());
            let hide = set_hidden(app, false);
            grab.and(hide)
        }
    }

    pub fn unlock_if_locked(app: &tauri::AppHandle, window: &tauri::Window) -> Result<(), String> {
        let hidden = {
            let state = app.state::<FlyCursorState>();
            let guard = state.hidden.lock().map_err(|e| e.to_string())?;
            *guard
        };
        if !hidden {
            return Ok(());
        }
        let grab = window.set_cursor_grab(false).map_err(|e| e.to_string());
        let hide = set_hidden(app, false);
        grab.and(hide)
    }

    /// Hide or show the (app-global, AppKit-counted) cursor exactly once per
    /// transition; `NSCursor` is main-thread-only, hence the dispatch.
    fn set_hidden(app: &tauri::AppHandle, hide: bool) -> Result<(), String> {
        {
            let state = app.state::<FlyCursorState>();
            let mut guard = state.hidden.lock().map_err(|e| e.to_string())?;
            if *guard == hide {
                return Ok(());
            }
            *guard = hide;
        }
        app.run_on_main_thread(move || {
            if hide {
                NSCursor::hide();
            } else {
                NSCursor::unhide();
            }
        })
        .map_err(|e| e.to_string())
    }
}
