//! The sidecar: the `coasterworks serve` process this shell starts, what it says once it is up,
//! and how it is stopped. The shell holds no game logic; everything the player does goes over the
//! socket this process opens.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// How long a sidecar has to print its ready line.
const READY_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a sidecar asked to quit has to save the park and exit before it is forced to.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// The most of the sidecar's stderr kept to explain a failed start.
const STDERR_KEPT: usize = 8 * 1024;
/// What the first run's park is called: `coasterworks new --sample` makes this one.
const SAMPLE_PARK_NAME: &str = "Leafy Lake";

/// What `coasterworks serve` prints, as one line of JSON, once it is listening.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    pub ws_url: String,
    pub mcp_url: String,
    pub port: u16,
    pub token: String,
}

impl Ready {
    /// The script that puts the sidecar's address in the page, before any of the page's own
    /// scripts run. The web client reads `window.__COASTERWORKS__` ahead of its query string, so
    /// the window's URL stays clean (and the token out of it).
    pub fn init_script(&self) -> String {
        let config = json!({ "wsUrl": self.ws_url, "token": self.token, "mcpUrl": self.mcp_url });
        format!("window.__COASTERWORKS__ = {config};")
    }

    /// The MCP client config that points an agent at this sidecar: what File > Copy MCP Config
    /// puts on the clipboard.
    pub fn mcp_config(&self) -> String {
        let config = json!({
            "mcpServers": {
                "coasterworks": {
                    "type": "http",
                    "url": self.mcp_url,
                    "headers": { "Authorization": format!("Bearer {}", self.token) }
                }
            }
        });
        serde_json::to_string_pretty(&config).expect("a JSON value always serializes")
    }
}

/// The ready line, or `None` for anything else the sidecar might print.
pub fn parse_ready_line(line: &str) -> Option<Ready> {
    serde_json::from_str(line.trim()).ok()
}

/// A running sidecar, and where it says it is listening.
pub struct Sidecar {
    pub ready: Ready,
    child: CommandChild,
    /// Signalled once the process has gone and its output has been read to the end.
    exited: mpsc::Receiver<()>,
    /// Set when the shell means to stop the sidecar, so that its exit is not taken for a fault.
    stopping: Arc<AtomicBool>,
}

impl Sidecar {
    /// The sidecar's process id.
    pub fn pid(&self) -> u32 {
        self.child.pid()
    }

    /// Stops the sidecar. It is asked to quit with SIGTERM, which makes it close its windows and
    /// write the park, and is killed outright only if it has not gone within `STOP_TIMEOUT`.
    pub fn kill(self) {
        self.kill_within(STOP_TIMEOUT);
    }

    /// `kill`, with the wait for a graceful exit set by the caller.
    pub fn kill_within(self, wait: Duration) {
        // Before the signal, so the exit it causes is never reported as the sidecar dying.
        self.stopping.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        {
            // Already gone (or its output reader is): there is nothing to signal, and its pid
            // may be someone else's by now.
            if !matches!(self.exited.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                return;
            }
            if let Some(pid) = as_pid(self.child.pid()) {
                // SAFETY: `kill(2)` takes two integers and reads no memory.
                let sent = unsafe { libc::kill(pid, libc::SIGTERM) } == 0;
                if sent
                    && !matches!(
                        self.exited.recv_timeout(wait),
                        Err(RecvTimeoutError::Timeout)
                    )
                {
                    return;
                }
            }
            // A pid that does not fit, a signal that could not be sent, or one that was ignored:
            // fall through to the plugin's kill, which is SIGKILL.
        }
        #[cfg(not(unix))]
        let _ = wait;
        let _ = self.child.kill();
    }
}

/// `pid` as the type `kill(2)` takes, or `None` if it does not fit: a plain `as` would wrap a
/// large value to a negative one, which `kill(2)` reads as a process group.
#[cfg(unix)]
fn as_pid(pid: u32) -> Option<libc::pid_t> {
    libc::pid_t::try_from(pid).ok()
}

/// The CLI to run with `node`: `COASTERWORKS_CLI`, else the one built in this repository. The
/// compiled sidecar that ships with the app replaces this (Plan G).
fn cli_entry() -> Result<PathBuf, String> {
    let given = std::env::var_os("COASTERWORKS_CLI").filter(|value| !value.is_empty());
    let path = match given {
        Some(path) => PathBuf::from(path),
        // <repo>/apps/desktop/src-tauri/../../cli/dist/index.js
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../cli/dist/index.js"),
    };
    path.canonicalize().map_err(|err| {
        format!(
            "the coasterworks CLI is not at {} ({err}); run `pnpm build` in the repository, or set COASTERWORKS_CLI",
            path.display()
        )
    })
}

/// `<app data dir>/parks/current.park`, with the directory made.
pub fn park_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("no app data directory: {err}"))?
        .join("parks");
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("could not create {}: {err}", dir.display()))?;
    Ok(dir.join("current.park"))
}

/// What `node` is given to make the first run's park: the sample park, Leafy Lake, with a hill
/// and a pond to shape, rather than a flat field.
fn new_park_args(cli: &Path, park: &Path) -> Vec<OsString> {
    vec![
        cli.as_os_str().to_owned(),
        "new".into(),
        "--out".into(),
        park.as_os_str().to_owned(),
        "--sample".into(),
        "--name".into(),
        SAMPLE_PARK_NAME.into(),
    ]
}

/// Makes a park at `park` if there is not one there yet.
fn ensure_park(cli: &Path, park: &Path) -> Result<(), String> {
    if park.exists() {
        return Ok(());
    }
    let output = StdCommand::new("node")
        .args(new_park_args(cli, park))
        .output()
        .map_err(|err| format!("could not run node (is it on PATH?): {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "`coasterworks new` failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// What `node` is given to run the sidecar. `--exit-on-stdin-eof` ties its life to ours: the shell
/// holds the other end of its stdin, so if the shell is killed and cannot stop it, it stops itself.
fn serve_args(cli: &Path, park: &Path) -> Vec<OsString> {
    vec![
        cli.as_os_str().to_owned(),
        "serve".into(),
        "--save".into(),
        park.as_os_str().to_owned(),
        "--out".into(),
        park.as_os_str().to_owned(),
        "--port".into(),
        "0".into(),
        "--exit-on-stdin-eof".into(),
    ]
}

/// Starts `coasterworks serve` on a free port and waits for it to say where it is listening.
/// The park is `park` (`current.park` in the app data directory, see `park_path`), made on the
/// first run; the sidecar writes it as the player edits.
///
/// `on_unexpected_exit` is called, once, with the exit code if there is one, if the sidecar exits
/// after it was ready without the shell having stopped it: the park can no longer be played.
pub fn spawn<R: Runtime>(
    app: &AppHandle<R>,
    park: &Path,
    on_unexpected_exit: impl FnOnce(Option<i32>) + Send + 'static,
) -> Result<Sidecar, String> {
    let cli = cli_entry()?;
    ensure_park(&cli, park)?;
    launch(app, "node", serve_args(&cli, park), on_unexpected_exit)
}

/// Runs `program args` as the sidecar and waits for its ready line. Apart from `spawn` it is what
/// the tests use, with stand-ins for `coasterworks serve`. See `spawn` for `on_unexpected_exit`.
pub(crate) fn launch<R: Runtime>(
    app: &AppHandle<R>,
    program: impl AsRef<OsStr>,
    args: Vec<OsString>,
    on_unexpected_exit: impl FnOnce(Option<i32>) + Send + 'static,
) -> Result<Sidecar, String> {
    let (mut events, child) = app
        .shell()
        .command(program)
        .args(args)
        .spawn()
        .map_err(|err| format!("could not start node (is it on PATH?): {err}"))?;

    let (ready_tx, ready_rx) = mpsc::channel::<Ready>();
    let (exited_tx, exited_rx) = mpsc::channel::<()>();
    let stderr = Arc::new(Mutex::new(String::new()));
    let kept = Arc::clone(&stderr);
    let stopping = Arc::new(AtomicBool::new(false));
    let stopping_seen = Arc::clone(&stopping);
    let mut on_unexpected_exit = Some(on_unexpected_exit);
    // Reads the sidecar's output until it exits, so its pipes never fill and its log is not lost.
    tauri::async_runtime::spawn(async move {
        let mut announced = false;
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let line = line.trim_end();
                    if !announced {
                        if let Some(ready) = parse_ready_line(line) {
                            announced = true;
                            let _ = ready_tx.send(ready);
                            continue;
                        }
                    }
                    eprintln!("[sidecar] {line}");
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let line = line.trim_end();
                    eprintln!("[sidecar] {line}");
                    if let Ok(mut kept) = kept.lock() {
                        if kept.len() < STDERR_KEPT {
                            kept.push_str(line);
                            kept.push('\n');
                        }
                    }
                }
                CommandEvent::Error(message) => eprintln!("[sidecar] error: {message}"),
                CommandEvent::Terminated(payload) => {
                    eprintln!("[sidecar] exited (code {:?})", payload.code);
                    // Said before the report, so that a shell that quits in answer to the report
                    // finds the sidecar gone and does not wait for it.
                    let _ = exited_tx.send(());
                    // One that never got as far as its ready line is `launch` failing, not this.
                    if announced && !stopping_seen.load(Ordering::SeqCst) {
                        if let Some(report) = on_unexpected_exit.take() {
                            report(payload.code);
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
        // `ready_tx` is dropped here, which is what tells a waiting `spawn` it exited early.
        let _ = exited_tx.send(());
    });

    match ready_rx.recv_timeout(READY_TIMEOUT) {
        Ok(ready) => Ok(Sidecar {
            ready,
            child,
            exited: exited_rx,
            stopping,
        }),
        Err(err) => {
            let _ = child.kill();
            let why = match err {
                RecvTimeoutError::Timeout => "did not say it was ready within 10 seconds",
                RecvTimeoutError::Disconnected => "exited before it was ready",
            };
            let said = stderr
                .lock()
                .map(|text| text.trim().to_owned())
                .unwrap_or_default();
            Err(if said.is_empty() {
                format!("the sidecar {why}")
            } else {
                format!("the sidecar {why}:\n{said}")
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE: &str = r#"{"wsUrl":"ws://127.0.0.1:49152/ws","mcpUrl":"http://127.0.0.1:49152/mcp","port":49152,"token":"abcDEF_-0123456789abcDEF_-0123456789abcdefg"}"#;

    fn ready() -> Ready {
        parse_ready_line(LINE).expect("a ready line parses")
    }

    #[test]
    fn parses_a_ready_line() {
        let ready = ready();
        assert_eq!(ready.ws_url, "ws://127.0.0.1:49152/ws");
        assert_eq!(ready.mcp_url, "http://127.0.0.1:49152/mcp");
        assert_eq!(ready.port, 49152);
        assert_eq!(ready.token, "abcDEF_-0123456789abcDEF_-0123456789abcdefg");
    }

    #[test]
    fn ignores_the_line_ending_and_padding() {
        assert!(parse_ready_line(&format!("  {LINE}\r\n")).is_some());
    }

    #[test]
    fn rejects_a_line_that_is_not_json() {
        assert_eq!(parse_ready_line("listening on 127.0.0.1:49152"), None);
        assert_eq!(parse_ready_line(""), None);
        assert_eq!(parse_ready_line("{not json"), None);
    }

    #[test]
    fn rejects_json_without_a_ws_url() {
        assert_eq!(parse_ready_line(r#"{"port":49152,"token":"t"}"#), None);
        assert_eq!(
            parse_ready_line(r#"{"mcpUrl":"http://127.0.0.1:1/mcp","port":1,"token":"t"}"#),
            None
        );
        assert_eq!(parse_ready_line("[]"), None);
        assert_eq!(parse_ready_line("null"), None);
    }

    #[test]
    fn the_init_script_assigns_the_address_the_web_client_reads() {
        let script = ready().init_script();
        let json = script
            .strip_prefix("window.__COASTERWORKS__ = ")
            .and_then(|rest| rest.strip_suffix(';'))
            .expect("one assignment");
        let config: serde_json::Value = serde_json::from_str(json).expect("the value is JSON");
        assert_eq!(
            config,
            serde_json::json!({
                "wsUrl": "ws://127.0.0.1:49152/ws",
                "token": "abcDEF_-0123456789abcDEF_-0123456789abcdefg",
                "mcpUrl": "http://127.0.0.1:49152/mcp",
            })
        );
    }

    #[test]
    fn the_mcp_config_points_an_agent_at_the_sidecar_with_its_token() {
        let config: serde_json::Value = serde_json::from_str(&ready().mcp_config()).expect("JSON");
        assert_eq!(
            config,
            serde_json::json!({
                "mcpServers": {
                    "coasterworks": {
                        "type": "http",
                        "url": "http://127.0.0.1:49152/mcp",
                        "headers": { "Authorization": "Bearer abcDEF_-0123456789abcDEF_-0123456789abcdefg" }
                    }
                }
            })
        );
    }

    #[test]
    fn the_sidecar_is_told_to_exit_when_its_stdin_ends() {
        let args = serve_args(
            Path::new("/cli/index.js"),
            Path::new("/data/parks/current.park"),
        );
        let args: Vec<&str> = args.iter().map(|arg| arg.to_str().unwrap()).collect();
        assert_eq!(
            args,
            [
                "/cli/index.js",
                "serve",
                "--save",
                "/data/parks/current.park",
                "--out",
                "/data/parks/current.park",
                "--port",
                "0",
                "--exit-on-stdin-eof",
            ]
        );
    }

    #[test]
    fn the_first_run_makes_the_sample_park_called_leafy_lake() {
        let args = new_park_args(
            Path::new("/cli/index.js"),
            Path::new("/data/parks/current.park"),
        );
        let args: Vec<&str> = args.iter().map(|arg| arg.to_str().unwrap()).collect();
        assert_eq!(
            args,
            [
                "/cli/index.js",
                "new",
                "--out",
                "/data/parks/current.park",
                "--sample",
                "--name",
                "Leafy Lake",
            ]
        );
    }

    #[test]
    fn the_real_cli_makes_leafy_lake_once_and_leaves_a_park_that_exists_alone() {
        let cli = cli_entry().expect("the CLI is built: run `pnpm build` first");
        let dir = std::env::temp_dir().join(format!(
            "coasterworks-desktop-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let park = dir.join("parks").join("current.park");
        std::fs::create_dir_all(park.parent().unwrap()).unwrap();

        ensure_park(&cli, &park).expect("the first run makes the park");
        let inspected = StdCommand::new("node")
            .arg(&cli)
            .arg("inspect")
            .arg(&park)
            .output()
            .expect("node is on PATH");
        assert!(inspected.status.success(), "{inspected:?}");
        let inspected: serde_json::Value =
            serde_json::from_slice(&inspected.stdout).expect("inspect prints JSON");
        assert_eq!(inspected["status"]["name"], "Leafy Lake");
        assert_eq!(inspected["status"]["width"], 64);
        assert_eq!(inspected["status"]["height"], 64);

        // A second run finds the player's park and does nothing to it.
        let before = std::fs::read(&park).unwrap();
        ensure_park(&cli, &park).expect("an existing park is fine");
        assert_eq!(std::fs::read(&park).unwrap(), before);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_pid_that_does_not_fit_is_not_signalled() {
        assert_eq!(as_pid(1234), Some(1234));
        assert_eq!(as_pid(i32::MAX as u32), Some(i32::MAX));
        // `as` would wrap these to negative numbers, which `kill(2)` reads as process groups.
        assert_eq!(as_pid(i32::MAX as u32 + 1), None);
        assert_eq!(as_pid(u32::MAX), None);
    }

    /// Runs `script` the way the webview does (a function body that sees `window`) in node, and
    /// gives back what it left in `window`, so what is checked is the JavaScript itself.
    fn run_in_node(script: &str) -> serde_json::Value {
        use std::io::Write;
        use std::process::Stdio;
        let mut node = StdCommand::new("node")
            .args([
                "-e",
                r#"const window = {};
                   new Function("window", require("fs").readFileSync(0, "utf8"))(window);
                   process.stdout.write(JSON.stringify(window));"#,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("node is on PATH");
        node.stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        let output = node.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "node rejected the script: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).expect("node printed JSON")
    }

    #[test]
    fn the_init_script_stays_one_statement_with_a_hostile_token() {
        // A quote, a backslash, a line break (both kinds), an HTML end tag, and U+2028, which
        // JSON allows raw and older JavaScript did not.
        let token = "q\"uote \\back\nline\r</script>\u{2028}end";
        let ready = Ready {
            token: token.to_owned(),
            ..ready()
        };
        let script = ready.init_script();

        // The escaped forms are what is in the text, and there is no raw line break.
        for escaped in [r#"q\"uote"#, r"\\back", r"\nline", r"\r"] {
            assert!(
                script.contains(escaped),
                "{escaped} is missing from {script}"
            );
        }
        assert!(
            !script.contains('\n') && !script.contains('\r'),
            "a raw line break in {script}"
        );
        assert!(script.starts_with("window.__COASTERWORKS__ = {") && script.ends_with("};"));

        // It parses as JSON and gives the token back exactly...
        let json = script
            .strip_prefix("window.__COASTERWORKS__ = ")
            .and_then(|rest| rest.strip_suffix(';'))
            .expect("one assignment");
        let parsed: serde_json::Value = serde_json::from_str(json).expect("the value is JSON");
        assert_eq!(parsed["token"], token);

        // ...and so does JavaScript, which sets nothing on `window` but the one name.
        let window = run_in_node(&script);
        assert_eq!(window.as_object().unwrap().len(), 1, "{window}");
        assert_eq!(window["__COASTERWORKS__"]["token"], token);
        assert_eq!(window["__COASTERWORKS__"]["wsUrl"], ready.ws_url);
        assert_eq!(window["__COASTERWORKS__"]["mcpUrl"], ready.mcp_url);
    }
}
