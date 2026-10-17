//! The Coasterworks Mac app. It holds no game logic: it starts the `coasterworks serve` sidecar,
//! waits for it to say where it is listening, opens the web client against it, and owns the menu.

pub mod sidecar;

use std::path::Path;
use std::sync::Mutex;

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindowBuilder, Wry,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use sidecar::Sidecar;

const COPY_MCP_CONFIG: &str = "copy-mcp-config";
const CLASSIC_VIEW: &str = "classic-view";
/// The event the web client listens for to step the camera to the next classic angle.
const CLASSIC_VIEW_EVENT: &str = "coasterworks://classic-view";

/// What the native dialogs are titled.
const DIALOG_TITLE: &str = "Coasterworks";
/// Said when the sidecar dies while the app is running: nothing can be played without it.
const SIDECAR_STOPPED_TEXT: &str = "The park process stopped unexpectedly. Coasterworks will quit.";

/// What the dialog says when the app could not start: what went wrong, and, if the park file is
/// known, where it is and how to start over, since a damaged park is a likely cause.
fn startup_failure_text(error: &str, park: Option<&Path>) -> String {
    let mut text = format!("Coasterworks could not start.\n\n{error}");
    if let Some(park) = park {
        text.push_str(&format!(
            "\n\nPark file: {}\nMove or delete the park file to start fresh.",
            park.display()
        ));
    }
    text
}

/// Shows `text` in a native error dialog and runs `then` when it is dismissed.
///
/// It returns at once: `show` is used, not `blocking_show`, because the dialog is put up by the
/// main thread, and a caller on the main thread (the setup closure is) that waited for it would
/// wait for itself. The app's event loop shows the dialog once the caller has returned.
fn show_error_dialog<R: Runtime>(
    app: &AppHandle<R>,
    text: String,
    then: impl FnOnce() + Send + 'static,
) {
    app.dialog()
        .message(text)
        .title(DIALOG_TITLE)
        .kind(MessageDialogKind::Error)
        .show(move |_| then());
}

/// The app could not start. Says why, in a dialog and on stderr, and ends the process with exit
/// code 1 once the dialog is dismissed. The caller returns afterwards, and the event loop runs
/// only to show the dialog.
fn fail_startup<R: Runtime>(app: &AppHandle<R>, error: &str, park: Option<&Path>) {
    eprintln!("coasterworks: {error}");
    show_error_dialog(app, startup_failure_text(error, park), || {
        std::process::exit(1)
    });
}

/// What the sidecar's reader calls if it dies while the app runs: says so, then quits with exit
/// code 1. Through `AppHandle::exit`, so the usual exit handling runs.
fn quit_after_sidecar_died(app: &AppHandle) -> impl FnOnce(Option<i32>) + Send + 'static {
    let app = app.clone();
    move |code| {
        eprintln!("coasterworks: the sidecar exited unexpectedly (code {code:?})");
        let quit = app.clone();
        show_error_dialog(&app, SIDECAR_STOPPED_TEXT.to_owned(), move || quit.exit(1));
    }
}

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
fn stop_sidecar<R: Runtime>(app: &AppHandle<R>) {
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

/// Puts a started sidecar in the app's state and opens the window with `open_window`, which is
/// given the script that tells the page where the sidecar is.
///
/// If the window cannot be opened the sidecar is stopped before the error is returned. Nothing
/// else would stop it: a failed startup ends the process without `ExitRequested` or `Exit`, so the
/// handler below never runs, and the sidecar would be left holding its port and the park.
fn start_with<R: Runtime>(
    app: &AppHandle<R>,
    sidecar: Sidecar,
    open_window: impl FnOnce(&str) -> Result<(), Box<dyn std::error::Error>>,
) -> Result<(), Box<dyn std::error::Error>> {
    let init_script = sidecar.ready.init_script();
    app.manage::<SidecarSlot>(Mutex::new(Some(sidecar)));
    open_window(&init_script).inspect_err(|_| stop_sidecar(app))
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .menu(build_menu)
        .on_menu_event(on_menu_event)
        .setup(|app| {
            let park = match sidecar::park_path(app.handle()) {
                Ok(park) => park,
                Err(message) => {
                    fail_startup(app.handle(), &message, None);
                    return Ok(());
                }
            };
            let sidecar =
                match sidecar::spawn(app.handle(), &park, quit_after_sidecar_died(app.handle())) {
                    Ok(sidecar) => sidecar,
                    Err(message) => {
                        let error = format!("could not start the sidecar: {message}");
                        fail_startup(app.handle(), &error, Some(&park));
                        return Ok(());
                    }
                };
            // `WebviewUrl::default()` is the dev server under `tauri dev` and the built web
            // client otherwise. The window is made here, not in tauri.conf.json, because the page
            // needs the sidecar's address in place before it loads.
            let opened = start_with(app.handle(), sidecar, |init_script| {
                WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                    .title("Coasterworks")
                    .inner_size(1400.0, 900.0)
                    .min_inner_size(1100.0, 700.0)
                    .initialization_script(init_script)
                    .build()?;
                Ok(())
            });
            if let Err(err) = opened {
                // The sidecar is already stopped. Returning the error would make Tauri panic.
                let error = format!("could not open the window: {err}");
                fail_startup(app.handle(), &error, Some(&park));
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

    /// A stand-in for `coasterworks serve`: quits on SIGTERM, and also when its stdin ends, as the
    /// real one does with `--exit-on-stdin-eof`. It says it is ready last, as the real one does,
    /// so that a signal sent on seeing the line finds its handler in place.
    const WELL_BEHAVED: &str = r#"
        process.on("SIGTERM", () => process.exit(0));
        process.stdin.on("end", () => process.exit(0));
        process.stdin.resume();
        setInterval(() => {}, 1000);
        console.log(JSON.stringify({ wsUrl: "ws://127.0.0.1:1/ws", mcpUrl: "http://127.0.0.1:1/mcp", port: 1, token: "t" }));
    "#;
    /// One that ignores SIGTERM and does not watch stdin, which only SIGKILL stops.
    const STUBBORN: &str = r#"
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1000);
        console.log(JSON.stringify({ wsUrl: "ws://127.0.0.1:1/ws", mcpUrl: "http://127.0.0.1:1/mcp", port: 1, token: "t" }));
    "#;
    /// One that is ready and then exits on its own.
    const SHORT_LIVED: &str = r#"
        console.log(JSON.stringify({ wsUrl: "ws://127.0.0.1:1/ws", mcpUrl: "http://127.0.0.1:1/mcp", port: 1, token: "t" }));
        setTimeout(() => process.exit(0), 50);
    "#;

    fn app() -> tauri::App<MockRuntime> {
        mock_builder()
            .plugin(tauri_plugin_shell::init())
            .build(mock_context(noop_assets()))
            .expect("a mock app")
    }

    fn fake(app: &AppHandle<MockRuntime>, script: &str) -> Sidecar {
        sidecar::launch(app, "node", vec!["-e".into(), script.into()], |_| {})
            .expect("the fake is ready")
    }

    /// A stand-in that is ready, and a channel that hears what is reported if it dies unasked.
    fn fake_reporting(
        app: &AppHandle<MockRuntime>,
        script: &str,
    ) -> (Sidecar, std::sync::mpsc::Receiver<Option<i32>>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let sidecar = sidecar::launch(app, "node", vec!["-e".into(), script.into()], move |code| {
            let _ = tx.send(code);
        })
        .expect("the fake is ready");
        (sidecar, rx)
    }

    /// Whether a process with this pid exists. A child that has been waited for does not.
    fn alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    fn eventually(what: &str, mut check: impl FnMut() -> bool) {
        let start = Instant::now();
        while !check() {
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "timed out: {what}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn slot_is_empty(app: &AppHandle<MockRuntime>) -> bool {
        app.state::<SidecarSlot>().lock().unwrap().is_none()
    }

    #[test]
    fn a_window_that_cannot_be_opened_stops_the_sidecar() {
        let app = app();
        let handle = app.handle();
        let sidecar = fake(handle, WELL_BEHAVED);
        let pid = sidecar.pid();
        assert!(alive(pid));

        let mut offered = None;
        let result = start_with(handle, sidecar, |script| {
            offered = Some(script.to_owned());
            Err("the window could not be created".into())
        });

        // The error still goes up, the window was offered the address, and nothing is left running.
        assert_eq!(
            result.unwrap_err().to_string(),
            "the window could not be created"
        );
        assert!(offered.unwrap().starts_with("window.__COASTERWORKS__ = "));
        assert!(!alive(pid), "the sidecar outlived the failed startup");
        assert!(slot_is_empty(handle));
    }

    #[test]
    fn an_opened_window_leaves_the_sidecar_running_until_it_is_stopped() {
        let app = app();
        let handle = app.handle();
        let sidecar = fake(handle, WELL_BEHAVED);
        let pid = sidecar.pid();

        start_with(handle, sidecar, |_| Ok(())).expect("startup succeeds");
        assert!(alive(pid));
        assert!(!slot_is_empty(handle));

        stop_sidecar(handle);
        assert!(!alive(pid));
        assert!(slot_is_empty(handle));
        // ExitRequested and then Exit both stop it; the second finds nothing to do.
        stop_sidecar(handle);
    }

    #[test]
    fn the_startup_failure_dialog_names_the_error_the_park_and_how_to_start_over() {
        let text = startup_failure_text(
            "could not start the sidecar: the sidecar exited before it was ready:\nbad park",
            Some(Path::new("/data/parks/current.park")),
        );
        assert!(text.starts_with("Coasterworks could not start."), "{text}");
        assert!(text.contains("the sidecar exited before it was ready:\nbad park"));
        assert!(text.contains("Park file: /data/parks/current.park"));
        assert!(text.ends_with("Move or delete the park file to start fresh."));
    }

    #[test]
    fn the_startup_failure_dialog_has_no_park_line_when_there_is_no_park_yet() {
        let text = startup_failure_text("no app data directory: nope", None);
        assert!(text.contains("no app data directory: nope"));
        assert!(!text.contains("Park file"));
        assert!(!text.contains("Move or delete"));
    }

    #[test]
    fn the_sidecar_stopped_dialog_says_what_the_player_needs_to_know() {
        assert_eq!(
            SIDECAR_STOPPED_TEXT,
            "The park process stopped unexpectedly. Coasterworks will quit."
        );
    }

    #[test]
    fn a_sidecar_that_dies_on_its_own_is_reported_once_with_its_exit_code() {
        let app = app();
        let (_sidecar, reports) = fake_reporting(app.handle(), SHORT_LIVED);
        assert_eq!(reports.recv_timeout(Duration::from_secs(10)), Ok(Some(0)));
        assert!(reports.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn a_sidecar_the_shell_stops_is_not_reported_as_dying() {
        let app = app();
        let (sidecar, reports) = fake_reporting(app.handle(), WELL_BEHAVED);
        let pid = sidecar.pid();
        sidecar.kill();
        assert!(!alive(pid));
        assert!(
            reports.recv_timeout(Duration::from_millis(500)).is_err(),
            "a stop the shell asked for was reported"
        );
    }

    #[test]
    fn a_sidecar_that_had_to_be_killed_is_not_reported_either() {
        let app = app();
        let (sidecar, reports) = fake_reporting(app.handle(), STUBBORN);
        sidecar.kill_within(Duration::from_millis(200));
        assert!(reports.recv_timeout(Duration::from_millis(500)).is_err());
    }

    #[test]
    fn a_sidecar_that_exits_before_it_is_ready_is_a_failed_start_and_not_reported_as_dying() {
        let app = app();
        let (tx, reports) = std::sync::mpsc::channel();
        let started = sidecar::launch(
            app.handle(),
            "node",
            vec!["-e".into(), "process.exit(3)".into()],
            move |code| {
                let _ = tx.send(code);
            },
        );
        let error = started.err().expect("it never said it was ready");
        assert!(error.contains("exited before it was ready"), "{error}");
        assert!(reports.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn stopping_without_a_sidecar_does_nothing() {
        let app = app();
        // Nothing was ever managed, as when startup failed before the sidecar existed.
        stop_sidecar(app.handle());
    }

    #[test]
    fn a_sidecar_that_ignores_sigterm_is_killed_after_the_wait() {
        let app = app();
        let sidecar = fake(app.handle(), STUBBORN);
        let pid = sidecar.pid();
        let start = Instant::now();
        sidecar.kill_within(Duration::from_millis(300));
        assert!(!alive(pid));
        assert!(
            start.elapsed() >= Duration::from_millis(300),
            "it was not given the wait"
        );
    }

    #[test]
    fn a_sidecar_that_quits_on_sigterm_is_not_waited_on_for_long() {
        let app = app();
        let sidecar = fake(app.handle(), WELL_BEHAVED);
        let pid = sidecar.pid();
        let start = Instant::now();
        sidecar.kill_within(Duration::from_secs(30));
        assert!(!alive(pid));
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "it took the whole wait"
        );
    }

    #[test]
    fn a_sidecar_that_has_already_exited_is_left_alone() {
        let app = app();
        let sidecar = fake(app.handle(), SHORT_LIVED);
        let pid = sidecar.pid();
        eventually("the short-lived sidecar to exit", || !alive(pid));
        // Its pid is free to be someone else's now: kill must not signal it, and must not hang.
        let start = Instant::now();
        sidecar.kill();
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn losing_the_shell_ends_the_sidecars_stdin_so_it_can_stop_itself() {
        let app = app();
        let sidecar = fake(app.handle(), WELL_BEHAVED);
        let pid = sidecar.pid();
        assert!(alive(pid));
        // What a killed shell does without meaning to: its end of the sidecar's stdin closes.
        drop(sidecar);
        eventually("the sidecar to see its stdin end and exit", || !alive(pid));
    }
}
