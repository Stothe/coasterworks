//! The Coasterworks Mac app. It holds no game logic: it starts the `coasterworks serve` sidecar,
//! waits for it to say where it is listening, opens the web client against it, and owns the menu.

pub mod sidecar;

use std::sync::Mutex;

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_clipboard_manager::ClipboardExt;

use sidecar::Sidecar;

const COPY_MCP_CONFIG: &str = "copy-mcp-config";
const CLASSIC_VIEW: &str = "classic-view";
/// The event the web client listens for to put the camera back at the first classic angle.
const CLASSIC_VIEW_EVENT: &str = "coasterworks://classic-view";

/// The running sidecar, until the app takes it out to stop it.
type SidecarSlot = Mutex<Option<Sidecar>>;

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let app_menu = SubmenuBuilder::new(app, "Coasterworks")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id(COPY_MCP_CONFIG, "Copy MCP Config").build(app)?)
        .separator()
        .close_window()
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id(CLASSIC_VIEW, "Classic View").build(app)?)
        .separator()
        .fullscreen()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &view])
        .build()
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        COPY_MCP_CONFIG => {
            let Some(slot) = app.try_state::<SidecarSlot>() else {
                return;
            };
            let config = {
                let guard = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.as_ref().map(|sidecar| sidecar.ready.mcp_config())
            };
            if let Some(config) = config {
                if let Err(err) = app.clipboard().write_text(config) {
                    eprintln!("coasterworks: could not copy the MCP config: {err}");
                }
            }
        }
        CLASSIC_VIEW => {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(err) = window.emit(CLASSIC_VIEW_EVENT, ()) {
                    eprintln!("coasterworks: could not send {CLASSIC_VIEW_EVENT}: {err}");
                }
            }
        }
        _ => {}
    }
}

/// Stops the sidecar if there is one, and only once: it is taken out of its slot.
fn stop_sidecar(app: &AppHandle) {
    let Some(slot) = app.try_state::<SidecarSlot>() else {
        return;
    };
    let taken = slot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(sidecar) = taken {
        sidecar.kill();
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .menu(build_menu)
        .on_menu_event(on_menu_event)
        .setup(|app| {
            let sidecar = match sidecar::spawn(app.handle()) {
                Ok(sidecar) => sidecar,
                Err(message) => {
                    eprintln!("coasterworks: could not start the sidecar: {message}");
                    std::process::exit(1);
                }
            };
            let init_script = sidecar.ready.init_script();
            app.manage::<SidecarSlot>(Mutex::new(Some(sidecar)));

            // `WebviewUrl::default()` is the dev server under `tauri dev` and the built web
            // client otherwise. The window is made here, not in tauri.conf.json, because the page
            // needs the sidecar's address in place before it loads.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Coasterworks")
                .inner_size(1400.0, 900.0)
                .min_inner_size(1100.0, 700.0)
                .initialization_script(init_script)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Coasterworks app");

    app.run(|app, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            stop_sidecar(app);
        }
    });
}
