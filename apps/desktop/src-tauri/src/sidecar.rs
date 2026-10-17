//! The sidecar: the `coasterworks serve` process this shell starts, what it says once it is up,
//! and how it is stopped. The shell holds no game logic; everything the player does goes over the
//! socket this process opens.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// How long a sidecar has to print its ready line.
const READY_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a sidecar asked to quit has to save the park and exit before it is forced to.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// The most of the sidecar's stderr kept to explain a failed start.
const STDERR_KEPT: usize = 8 * 1024;

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
}

impl Sidecar {
    /// Stops the sidecar. It is asked to quit with SIGTERM, which makes it close its windows and
    /// write the park, and is killed outright only if it has not gone within `STOP_TIMEOUT`.
    pub fn kill(self) {
        #[cfg(unix)]
        {
            // Already gone (or its output reader is): there is nothing to signal, and its pid
            // may be someone else's by now.
            if !matches!(self.exited.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                return;
            }
            // SAFETY: `kill(2)` takes two integers and reads no memory.
            let sent = unsafe { libc::kill(self.child.pid() as libc::pid_t, libc::SIGTERM) } == 0;
            if sent
                && !matches!(
                    self.exited.recv_timeout(STOP_TIMEOUT),
                    Err(RecvTimeoutError::Timeout)
                )
            {
                return;
            }
        }
        let _ = self.child.kill();
    }
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
fn park_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("no app data directory: {err}"))?
        .join("parks");
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("could not create {}: {err}", dir.display()))?;
    Ok(dir.join("current.park"))
}

/// Makes a park at `park` if there is not one there yet.
fn ensure_park(cli: &Path, park: &Path) -> Result<(), String> {
    if park.exists() {
        return Ok(());
    }
    let output = StdCommand::new("node")
        .arg(cli)
        .args(["new", "--out"])
        .arg(park)
        .args(["--name", "My Park"])
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

/// Starts `coasterworks serve` on a free port and waits for it to say where it is listening.
/// The park is `current.park` in the app data directory, made on the first run; the sidecar
/// writes it as the player edits.
pub fn spawn(app: &AppHandle) -> Result<Sidecar, String> {
    let cli = cli_entry()?;
    let park = park_path(app)?;
    ensure_park(&cli, &park)?;

    let args: Vec<OsString> = vec![
        cli.into_os_string(),
        "serve".into(),
        "--save".into(),
        park.clone().into_os_string(),
        "--out".into(),
        park.into_os_string(),
        "--port".into(),
        "0".into(),
    ];
    let (mut events, child) = app
        .shell()
        .command("node")
        .args(args)
        .spawn()
        .map_err(|err| format!("could not start node (is it on PATH?): {err}"))?;

    let (ready_tx, ready_rx) = mpsc::channel::<Ready>();
    let (exited_tx, exited_rx) = mpsc::channel::<()>();
    let stderr = Arc::new(Mutex::new(String::new()));
    let kept = Arc::clone(&stderr);
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
}
