//! Bidirectional clipboard proxy for the yolo bubblewrap sandbox.
//!
//! Host side (`broker`): listens on a dedicated Unix socket and translates a
//! fixed two-op protocol into fixed `tmux load-buffer` / `tmux save-buffer`
//! invocations against the *outer* tmux server. No client-supplied command
//! strings ever reach tmux argv.
//!
//! Sandbox side (argv0 `tmux`, or `tmux-shim`): accepts only the buffer
//! read/write subcommands that agent tools use for clipboard, and forwards
//! them to the broker. Every other tmux verb (run-shell, new-window, …) is
//! rejected, so a sandboxed process cannot confused-deputy the host tmux
//! server into executing arbitrary commands.
//!
//! Wire protocol (length-prefixed, little-endian u32 lengths):
//!   request:  tag:u8 (1=SET, 2=GET) [+ u32 len + bytes for SET]
//!   response: tag:u8 (0=OK, 1=ERR, 2=DATA) [+ u32 len + bytes]

use std::convert::TryFrom;
use std::env;
use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const DEFAULT_MAX_BYTES: u32 = 1_048_576; // 1 MiB
const TAG_SET: u8 = 1;
const TAG_GET: u8 = 2;
const TAG_OK: u8 = 0;
const TAG_ERR: u8 = 1;
const TAG_DATA: u8 = 2;

fn main() {
    let argv0 = env::args_os()
        .next()
        .and_then(|a| {
            Path::new(&a)
                .file_name()
                .map(|f| f.to_string_lossy().into_owned())
        })
        .unwrap_or_default();

    let mut args: Vec<String> = env::args().skip(1).collect();

    // Symlink-as-tmux installation path used inside the sandbox.
    if argv0 == "tmux" {
        if let Err(e) = run_tmux_shim(&args) {
            eprintln!("yolo-clipboard-proxy tmux shim: {e}");
            std::process::exit(1);
        }
        return;
    }

    let cmd = args.first().map(String::as_str).unwrap_or("help");
    match cmd {
        "broker" => {
            args.remove(0);
            if let Err(e) = run_broker(&args) {
                eprintln!("yolo-clipboard-proxy broker: {e}");
                std::process::exit(1);
            }
        }
        "tmux-shim" => {
            args.remove(0);
            if let Err(e) = run_tmux_shim(&args) {
                eprintln!("yolo-clipboard-proxy tmux shim: {e}");
                std::process::exit(1);
            }
        }
        "client" => {
            args.remove(0);
            if let Err(e) = run_client(&args) {
                eprintln!("yolo-clipboard-proxy client: {e}");
                std::process::exit(1);
            }
        }
        "help" | "-h" | "--help" => {
            print_help();
        }
        other => {
            eprintln!("yolo-clipboard-proxy: unknown command '{other}'");
            print_help();
            std::process::exit(2);
        }
    }
}

fn print_help() {
    eprintln!(
        "\
yolo-clipboard-proxy — fixed-op clipboard bridge for the yolo sandbox

Usage:
  yolo-clipboard-proxy broker --listen PATH --tmux-socket PATH [--tmux BIN] [--max-bytes N]
  yolo-clipboard-proxy tmux-shim [tmux-args...]
  yolo-clipboard-proxy client set|get
  (argv0 == tmux)  → tmux-shim

Environment (client / tmux-shim):
  YOLO_CLIPBOARD_SOCK  Unix socket path of the host broker
"
    );
}

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

struct BrokerConfig {
    listen: PathBuf,
    tmux_socket: PathBuf,
    tmux_bin: PathBuf,
    max_bytes: u32,
}

fn run_broker(args: &[String]) -> Result<(), String> {
    let cfg = parse_broker_args(args)?;

    if let Some(parent) = cfg.listen.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        let mut perms = fs::metadata(parent)
            .map_err(|e| format!("stat {}: {e}", parent.display()))?
            .permissions();
        perms.set_mode(0o700);
        fs::set_permissions(parent, perms)
            .map_err(|e| format!("chmod {}: {e}", parent.display()))?;
    }
    let _ = fs::remove_file(&cfg.listen);

    let listener = UnixListener::bind(&cfg.listen)
        .map_err(|e| format!("bind {}: {e}", cfg.listen.display()))?;
    let mut sock_perms = fs::metadata(&cfg.listen)
        .map_err(|e| format!("stat {}: {e}", cfg.listen.display()))?
        .permissions();
    sock_perms.set_mode(0o600);
    fs::set_permissions(&cfg.listen, sock_perms)
        .map_err(|e| format!("chmod {}: {e}", cfg.listen.display()))?;

    // Parent-death: when yolo exits without reaping us, stop promptly.
    install_pdeathsig_and_signals();

    eprintln!(
        "yolo-clipboard-proxy broker: listening on {} (tmux socket {})",
        cfg.listen.display(),
        cfg.tmux_socket.display()
    );

    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Err(e) = handle_client(stream, &cfg) {
                    eprintln!("yolo-clipboard-proxy broker: client error: {e}");
                }
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("accept: {e}")),
        }
    }
}

fn parse_broker_args(args: &[String]) -> Result<BrokerConfig, String> {
    let mut listen: Option<PathBuf> = None;
    let mut tmux_socket: Option<PathBuf> = None;
    let mut tmux_bin = PathBuf::from("tmux");
    let mut max_bytes = DEFAULT_MAX_BYTES;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--listen" => {
                i += 1;
                listen = Some(PathBuf::from(require_arg(args, i, "--listen")?));
            }
            "--tmux-socket" => {
                i += 1;
                tmux_socket = Some(PathBuf::from(require_arg(args, i, "--tmux-socket")?));
            }
            "--tmux" => {
                i += 1;
                tmux_bin = PathBuf::from(require_arg(args, i, "--tmux")?);
            }
            "--max-bytes" => {
                i += 1;
                let raw = require_arg(args, i, "--max-bytes")?;
                max_bytes = raw
                    .parse::<u32>()
                    .map_err(|_| format!("--max-bytes: not a u32: {raw}"))?;
                if max_bytes == 0 {
                    return Err("--max-bytes must be > 0".into());
                }
            }
            other => return Err(format!("broker: unknown argument '{other}'")),
        }
        i += 1;
    }
    Ok(BrokerConfig {
        listen: listen.ok_or("broker: --listen is required")?,
        tmux_socket: tmux_socket.ok_or("broker: --tmux-socket is required")?,
        tmux_bin,
        max_bytes,
    })
}

fn require_arg<'a>(args: &'a [String], idx: usize, flag: &str) -> Result<&'a str, String> {
    args.get(idx)
        .map(String::as_str)
        .ok_or_else(|| format!("broker: {flag} requires a value"))
}

fn handle_client(mut stream: UnixStream, cfg: &BrokerConfig) -> Result<(), String> {
    // Bound idle clients; clipboard ops should be instantaneous.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));

    let tag = read_u8(&mut stream)?;
    match tag {
        TAG_SET => {
            let payload = read_payload(&mut stream, cfg.max_bytes)?;
            match tmux_load_buffer(cfg, &payload) {
                Ok(()) => write_ok(&mut stream),
                Err(e) => write_err(&mut stream, &e),
            }
        }
        TAG_GET => match tmux_save_buffer(cfg) {
            Ok(data) => {
                if data.len() > cfg.max_bytes as usize {
                    write_err(
                        &mut stream,
                        &format!(
                            "tmux buffer exceeds max-bytes ({} > {})",
                            data.len(),
                            cfg.max_bytes
                        ),
                    )
                } else {
                    write_data(&mut stream, &data)
                }
            }
            Err(e) => write_err(&mut stream, &e),
        },
        other => write_err(&mut stream, &format!("unknown request tag {other}")),
    }
}

fn tmux_load_buffer(cfg: &BrokerConfig, payload: &[u8]) -> Result<(), String> {
    // Fixed argv. Payload travels only on stdin — never in argv.
    let mut child = Command::new(&cfg.tmux_bin)
        .arg("-S")
        .arg(&cfg.tmux_socket)
        .arg("load-buffer")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn tmux load-buffer: {e}"))?;

    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "tmux stdin missing".to_string())?;
        stdin
            .write_all(payload)
            .map_err(|e| format!("write tmux stdin: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("wait tmux load-buffer: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "tmux load-buffer failed (status {}): {}",
            output.status, stderr.trim()
        ));
    }
    Ok(())
}

fn tmux_save_buffer(cfg: &BrokerConfig) -> Result<Vec<u8>, String> {
    let output = Command::new(&cfg.tmux_bin)
        .arg("-S")
        .arg(&cfg.tmux_socket)
        .arg("save-buffer")
        .arg("-")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("spawn tmux save-buffer: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "tmux save-buffer failed (status {}): {}",
            output.status, stderr.trim()
        ));
    }
    Ok(output.stdout)
}

// ---------------------------------------------------------------------------
// Client / tmux shim
// ---------------------------------------------------------------------------

fn clipboard_sock_path() -> Result<PathBuf, String> {
    env::var_os("YOLO_CLIPBOARD_SOCK")
        .map(PathBuf::from)
        .ok_or_else(|| "YOLO_CLIPBOARD_SOCK is not set".into())
}

fn run_client(args: &[String]) -> Result<(), String> {
    let op = args
        .first()
        .map(String::as_str)
        .ok_or("client: expected 'set' or 'get'")?;
    match op {
        "set" => {
            let mut payload = Vec::new();
            io::stdin()
                .read_to_end(&mut payload)
                .map_err(|e| format!("read stdin: {e}"))?;
            client_set(&payload)?;
            Ok(())
        }
        "get" => {
            let data = client_get()?;
            io::stdout()
                .write_all(&data)
                .map_err(|e| format!("write stdout: {e}"))?;
            Ok(())
        }
        other => Err(format!("client: unknown op '{other}' (expected set|get)")),
    }
}

fn client_set(payload: &[u8]) -> Result<(), String> {
    if payload.len() > DEFAULT_MAX_BYTES as usize {
        return Err(format!(
            "payload exceeds max-bytes ({} > {})",
            payload.len(),
            DEFAULT_MAX_BYTES
        ));
    }
    let mut stream = UnixStream::connect(clipboard_sock_path()?)
        .map_err(|e| format!("connect broker: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    write_u8(&mut stream, TAG_SET)?;
    write_payload(&mut stream, payload)?;
    match read_u8(&mut stream)? {
        TAG_OK => Ok(()),
        TAG_ERR => Err(read_err_message(&mut stream)?),
        other => Err(format!("unexpected response tag {other}")),
    }
}

fn client_get() -> Result<Vec<u8>, String> {
    let mut stream = UnixStream::connect(clipboard_sock_path()?)
        .map_err(|e| format!("connect broker: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    write_u8(&mut stream, TAG_GET)?;
    match read_u8(&mut stream)? {
        TAG_DATA => read_payload(&mut stream, DEFAULT_MAX_BYTES),
        TAG_ERR => Err(read_err_message(&mut stream)?),
        other => Err(format!("unexpected response tag {other}")),
    }
}

/// Parse a subset of `tmux` argv used for clipboard and reject everything else.
fn run_tmux_shim(args: &[String]) -> Result<(), String> {
    let mut i = 0;
    // Skip global options. We deliberately ignore -S/-L: the shim never talks
    // to a tmux socket directly.
    while i < args.len() {
        match args[i].as_str() {
            "-S" | "-L" | "-f" | "-c" => {
                i += 2; // flag + value (value may be missing; treat as skip one)
                if i > args.len() {
                    i = args.len();
                }
            }
            "-v" | "-u" => i += 1,
            "-V" | "--version" => {
                println!("tmux 0.0-yolo-clipboard-proxy");
                return Ok(());
            }
            s if s.starts_with('-') => {
                return Err(format!("unsupported global option '{s}'"));
            }
            _ => break,
        }
    }
    if i >= args.len() {
        return Err("no tmux command given (clipboard shim supports load-buffer/save-buffer/show-buffer only)".into());
    }
    let cmd = args[i].as_str();
    i += 1;
    match cmd {
        "load-buffer" | "loadb" => shim_load_buffer(&args[i..]),
        "save-buffer" | "saveb" => shim_save_buffer(&args[i..]),
        "show-buffer" | "showb" => shim_show_buffer(&args[i..]),
        other => Err(format!(
            "tmux command '{other}' is not permitted inside the yolo sandbox \
             (clipboard shim allows only load-buffer/save-buffer/show-buffer; \
             host tmux socket is intentionally unreachable)"
        )),
    }
}

fn shim_load_buffer(args: &[String]) -> Result<(), String> {
    let path = parse_buffer_path(args, "load-buffer")?;
    let payload = read_path_or_stdin(&path)?;
    client_set(&payload)
}

fn shim_save_buffer(args: &[String]) -> Result<(), String> {
    let path = parse_buffer_path(args, "save-buffer")?;
    let data = client_get()?;
    write_path_or_stdout(&path, &data)
}

fn shim_show_buffer(args: &[String]) -> Result<(), String> {
    // show-buffer takes no path; reject -b and any other args.
    if let Some(arg) = args.first() {
        return Err(match arg.as_str() {
            "-b" => "named buffers (-b) are not supported by the clipboard shim".into(),
            other => format!("show-buffer: unexpected argument '{other}'"),
        });
    }
    let data = client_get()?;
    io::stdout()
        .write_all(&data)
        .map_err(|e| format!("write stdout: {e}"))?;
    Ok(())
}

fn parse_buffer_path(args: &[String], cmd: &str) -> Result<String, String> {
    let mut i = 0;
    let mut path: Option<String> = None;
    while i < args.len() {
        match args[i].as_str() {
            "-b" => {
                return Err("named buffers (-b) are not supported by the clipboard shim".into());
            }
            // Bare "-" is stdin/stdout, not an option.
            "-" => {
                if path.is_some() {
                    return Err(format!("{cmd}: unexpected extra argument '-'"));
                }
                path = Some("-".to_string());
                i += 1;
            }
            s if s.starts_with('-') => {
                return Err(format!("{cmd}: unsupported option '{s}'"));
            }
            s => {
                if path.is_some() {
                    return Err(format!("{cmd}: unexpected extra argument '{s}'"));
                }
                path = Some(s.to_string());
                i += 1;
            }
        }
    }
    path.ok_or_else(|| format!("{cmd}: missing path (use '-' for stdin/stdout)"))
}

fn read_path_or_stdin(path: &str) -> Result<Vec<u8>, String> {
    if path == "-" {
        let mut buf = Vec::new();
        io::stdin()
            .read_to_end(&mut buf)
            .map_err(|e| format!("read stdin: {e}"))?;
        Ok(buf)
    } else {
        fs::read(path).map_err(|e| format!("read {path}: {e}"))
    }
}

fn write_path_or_stdout(path: &str, data: &[u8]) -> Result<(), String> {
    if path == "-" {
        io::stdout()
            .write_all(data)
            .map_err(|e| format!("write stdout: {e}"))
    } else {
        fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .and_then(|mut f| f.write_all(data))
            .map_err(|e| format!("write {path}: {e}"))
    }
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

fn read_u8(r: &mut impl Read) -> Result<u8, String> {
    let mut b = [0u8; 1];
    r.read_exact(&mut b).map_err(|e| format!("read tag: {e}"))?;
    Ok(b[0])
}

fn write_u8(w: &mut impl Write, v: u8) -> Result<(), String> {
    w.write_all(&[v]).map_err(|e| format!("write tag: {e}"))
}

fn read_u32_le(r: &mut impl Read) -> Result<u32, String> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)
        .map_err(|e| format!("read length: {e}"))?;
    Ok(u32::from_le_bytes(b))
}

fn write_u32_le(w: &mut impl Write, v: u32) -> Result<(), String> {
    w.write_all(&v.to_le_bytes())
        .map_err(|e| format!("write length: {e}"))
}

fn read_payload(r: &mut impl Read, max_bytes: u32) -> Result<Vec<u8>, String> {
    let len = read_u32_le(r)?;
    if len > max_bytes {
        return Err(format!(
            "payload length {len} exceeds max-bytes {max_bytes}"
        ));
    }
    let mut buf = vec![0u8; len as usize];
    if len > 0 {
        r.read_exact(&mut buf)
            .map_err(|e| format!("read payload: {e}"))?;
    }
    Ok(buf)
}

fn write_payload(w: &mut impl Write, data: &[u8]) -> Result<(), String> {
    let len = u32::try_from(data.len()).map_err(|_| "payload too large for u32".to_string())?;
    write_u32_le(w, len)?;
    if !data.is_empty() {
        w.write_all(data)
            .map_err(|e| format!("write payload: {e}"))?;
    }
    Ok(())
}

fn write_ok(w: &mut impl Write) -> Result<(), String> {
    write_u8(w, TAG_OK)
}

fn write_err(w: &mut impl Write, msg: &str) -> Result<(), String> {
    write_u8(w, TAG_ERR)?;
    write_payload(w, msg.as_bytes())
}

fn write_data(w: &mut impl Write, data: &[u8]) -> Result<(), String> {
    write_u8(w, TAG_DATA)?;
    write_payload(w, data)
}

fn read_err_message(r: &mut impl Read) -> Result<String, String> {
    let bytes = read_payload(r, DEFAULT_MAX_BYTES)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// ---------------------------------------------------------------------------
// Process hygiene
// ---------------------------------------------------------------------------

fn install_pdeathsig_and_signals() {
    // Best-effort: on Linux, die when the parent (yolo) disappears. Primary
    // cleanup is still yolo.sh's EXIT trap (kill + rm socket dir).
    #[cfg(target_os = "linux")]
    {
        // prctl(PR_SET_PDEATHSIG, SIGTERM) — no libc crate; call directly.
        unsafe {
            extern "C" {
                fn prctl(option: i32, arg2: u64, arg3: u64, arg4: u64, arg5: u64) -> i32;
            }
            const PR_SET_PDEATHSIG: i32 = 1;
            const SIGTERM: u64 = 15;
            let _ = prctl(PR_SET_PDEATHSIG, SIGTERM, 0, 0, 0);
        }
    }
}
