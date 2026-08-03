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
//! Wire protocol (length-prefixed, little-endian u32 lengths, one request per
//! connection; any byte after a complete request is rejected unread):
//!   request:  tag:u8 (1=SET, 2=GET) [+ u32 len + bytes for SET]
//!   response: tag:u8 (0=OK, 1=ERR, 2=DATA) [+ u32 len + bytes]
//!
//! Bounds (tasks:T1794): every payload, diagnostic, and adapter stream is
//! bounded by the named constants below; the adapter runs under
//! ADAPTER_DEADLINE with concurrent stdin/stdout/stderr pumping so pipe
//! ordering cannot deadlock, and a deadline or overflow terminates and reaps
//! the child while the broker stays available for the next request.

use std::convert::TryFrom;
use std::env;
use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Clipboard payload bound (bytes), declared or streamed.
const CLIPBOARD_MAX_BYTES: u32 = 1_048_576; // 1 MiB
/// Bound on every returned diagnostic (bytes), adapter stderr included.
const DIAGNOSTIC_MAX_BYTES: usize = 4096;
/// Fixed deadline for one tmux adapter invocation; expiry terminates and
/// reaps the child.
const ADAPTER_DEADLINE: Duration = Duration::from_secs(10);
/// Poll interval while waiting for the adapter.
const ADAPTER_POLL_INTERVAL: Duration = Duration::from_millis(10);

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
    let mut max_bytes = CLIPBOARD_MAX_BYTES;
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
            let declared = read_u32_le(&mut stream)?;
            if declared > cfg.max_bytes {
                // Well-formed frame, policy violation: answer ERR without
                // reading a single body byte; the adapter is never invoked.
                return write_err(
                    &mut stream,
                    &format!("payload length {declared} exceeds max-bytes {}", cfg.max_bytes),
                );
            }
            let mut payload = vec![0u8; declared as usize];
            if declared > 0 {
                stream
                    .read_exact(&mut payload)
                    .map_err(|e| format!("read payload: {e}"))?;
            }
            if let Err(e) = reject_trailing(&mut stream) {
                return write_err(&mut stream, &e);
            }
            match tmux_load_buffer(cfg, &payload) {
                Ok(()) => write_ok(&mut stream),
                Err(e) => write_err(&mut stream, &e),
            }
        }
        TAG_GET => {
            if let Err(e) = reject_trailing(&mut stream) {
                return write_err(&mut stream, &e);
            }
            match tmux_save_buffer(cfg) {
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
            }
        }
        other => write_ok(&mut stream),
    }
}

/// One request per connection: any byte beyond a complete request frame is
/// rejected and the adapter is never invoked. A peek error fails closed. The
/// single peeked byte is consumed so the error response reaches the client
/// before the connection closes (an unread peeked byte would RST the reply).
fn reject_trailing(stream: &mut UnixStream) -> Result<(), String> {
    use std::os::unix::io::AsRawFd;
    // UnixStream::peek is unstable (unix_socket_peek); FFI recv with
    // MSG_PEEK|MSG_DONTWAIT gives the same non-destructive, non-blocking probe.
    extern "C" {
        fn recv(fd: i32, buf: *mut u8, len: usize, flags: i32) -> isize;
    }
    const MSG_PEEK: i32 = 0x2;
    const MSG_DONTWAIT: i32 = 0x40;
    let mut byte = 0u8;
    let n = unsafe { recv(stream.as_raw_fd(), &mut byte, 1, MSG_PEEK | MSG_DONTWAIT) };
    let trailing = match n {
        1 => true,
        0 => false,
        _ => {
            let err = io::Error::last_os_error();
            err.kind() != ErrorKind::WouldBlock
        }
    };
    if trailing {
        let mut drain = [0u8; 1];
        let _ = stream.read(&mut drain);
        return Err("trailing frame data after a complete request".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Adapter (fixed tmux argv, concurrent bounded pumping, hard deadline)
// ---------------------------------------------------------------------------

struct AdapterOutput {
    stdout: Vec<u8>,
}

/// Drains the stream to EOF (or child death) so the adapter never sees a
/// closed pipe, but retains at most `cap` bytes. `overflow` is set when the
/// stream held more than `cap - 1` bytes; the retained prefix stays bounded.
fn read_capped<R: Read + Send + 'static>(reader: R, cap: usize) -> ReadCapped {
    ReadCapped {
        handle: thread::spawn(move || {
            let mut reader = reader;
            let mut retained = Vec::with_capacity(cap);
            let mut chunk = [0u8; 65536];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        let room = cap.saturating_sub(retained.len());
                        if room > 0 {
                            retained.extend_from_slice(&chunk[..n.min(room)]);
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let overflow = retained.len() >= cap;
            (retained, overflow)
        }),
    }
}

struct ReadCapped {
    handle: thread::JoinHandle<(Vec<u8>, bool)>,
}

fn run_adapter(
    cfg: &BrokerConfig,
    verb: &str,
    input: Option<&[u8]>,
) -> Result<AdapterOutput, String> {
    // Fixed argv. Payload travels only on stdin — never in argv.
    let mut child = Command::new(&cfg.tmux_bin)
        .arg("-S")
        .arg(&cfg.tmux_socket)
        .arg(verb)
        .arg("-")
        .stdin(match input {
            Some(_) => Stdio::piped(),
            None => Stdio::null(),
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn tmux {verb}: {e}"))?;

    // Concurrent bounded pumping: pipe ordering cannot deadlock even when the
    // adapter fills stderr beyond pipe capacity before consuming stdin.
    let stdin_writer = match (child.stdin.take(), input) {
        (Some(mut w), Some(payload)) => {
            let payload = payload.to_vec();
            Some(thread::spawn(move || {
                let _ = w.write_all(&payload);
                // Drop w to signal EOF to the adapter.
            }))
        }
        _ => None,
    };
    let stdout_pump = child
        .stdout
        .take()
        .map(|r| read_capped(r, CLIPBOARD_MAX_BYTES as usize + 1));
    let stderr_pump = child
        .stderr
        .take()
        .map(|r| read_capped(r, DIAGNOSTIC_MAX_BYTES + 1));

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= ADAPTER_DEADLINE {
                    let _ = child.kill();
                    // Reap within the same call; SIGKILL is not deferrable.
                    let _ = child.wait();
                    if let Some(w) = stdin_writer {
                        let _ = w.join();
                    }
                    // Detach the output pumps: a leaked grandchild of the
                    // adapter can hold the pipes open past the kill, and the
                    // broker must answer within the deadline regardless. The
                    // detached pumps finish when the pipes finally EOF.
                    drop(stdout_pump);
                    drop(stderr_pump);
                    return Err(format!(
                        "tmux {verb} exceeded the {}s adapter deadline; child terminated and reaped",
                        ADAPTER_DEADLINE.as_secs()
                    ));
                }
                thread::sleep(ADAPTER_POLL_INTERVAL);
            }
            Err(e) => return Err(format!("wait tmux {verb}: {e}")),
        }
    };
    if let Some(w) = stdin_writer {
        let _ = w.join();
    }
    let (stdout, stdout_overflow) = match stdout_pump {
        Some(p) => p.handle.join().unwrap_or_default(),
        None => (Vec::new(), false),
    };
    if stdout_overflow {
        return Err(format!(
            "tmux {verb} stdout exceeds the {}-byte clipboard bound",
            CLIPBOARD_MAX_BYTES
        ));
    }
    let (stderr_raw, _) = match stderr_pump {
        Some(p) => p.handle.join().unwrap_or_default(),
        None => (Vec::new(), false),
    };
    let stderr = String::from_utf8_lossy(&stderr_raw).trim().to_string();
    if !status.success() {
        return Err(bound_diagnostic(format!(
            "tmux {verb} failed (status {status}): {stderr}"
        )));
    }
    Ok(AdapterOutput { stdout })
}

/// Every diagnostic returned to a client stays within DIAGNOSTIC_MAX_BYTES,
/// including the truncation marker.
fn bound_diagnostic(message: String) -> String {
    const MARKER: &str = "…[truncated]";
    if message.len() <= DIAGNOSTIC_MAX_BYTES {
        return message;
    }
    let mut end = DIAGNOSTIC_MAX_BYTES - MARKER.len();
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{MARKER}", &message[..end])
}

fn tmux_load_buffer(cfg: &BrokerConfig, payload: &[u8]) -> Result<(), String> {
    run_adapter(cfg, "load-buffer", Some(payload))?;
    Ok(())
}

fn tmux_save_buffer(cfg: &BrokerConfig) -> Result<Vec<u8>, String> {
    Ok(run_adapter(cfg, "save-buffer", None)?.stdout)
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
            let payload = read_stream_bounded(io::stdin(), CLIPBOARD_MAX_BYTES as usize + 1)?;
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

/// Reads a stream to EOF but stops after at most `cap` bytes; reaching the cap
/// means the stream exceeded the `cap - 1` bound and is an error.
fn read_stream_bounded<R: Read>(mut reader: R, cap: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; cap];
    let mut filled = 0usize;
    while filled < cap {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("read stream: {e}")),
        }
    }
    if filled >= cap {
        return Err(format!(
            "streamed input exceeds the {}-byte clipboard bound",
            CLIPBOARD_MAX_BYTES
        ));
    }
    buf.truncate(filled);
    Ok(buf)
}

fn client_set(payload: &[u8]) -> Result<(), String> {
    if payload.len() > CLIPBOARD_MAX_BYTES as usize {
        return Err(format!(
            "payload exceeds max-bytes ({} > {})",
            payload.len(),
            CLIPBOARD_MAX_BYTES
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
        TAG_DATA => read_payload(&mut stream, CLIPBOARD_MAX_BYTES),
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
    let cap = CLIPBOARD_MAX_BYTES as usize + 1;
    if path == "-" {
        read_stream_bounded(io::stdin(), cap)
    } else {
        // Declared size first: an oversized file is rejected before content.
        let declared = fs::metadata(path)
            .map_err(|e| format!("stat {path}: {e}"))?
            .len();
        if declared > CLIPBOARD_MAX_BYTES as u64 {
            return Err(format!(
                "file {path} exceeds the {}-byte clipboard bound ({declared} declared)",
                CLIPBOARD_MAX_BYTES
            ));
        }
        let file = fs::File::open(path).map_err(|e| format!("open {path}: {e}"))?;
        read_stream_bounded(file, cap).map_err(|e| format!("read {path}: {e}"))
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
    write_payload(w, bound_diagnostic(msg.to_string()).as_bytes())
}

fn write_data(w: &mut impl Write, data: &[u8]) -> Result<(), String> {
    write_u8(w, TAG_DATA)?;
    write_payload(w, data)
}

fn read_err_message(r: &mut impl Read) -> Result<String, String> {
    let bytes = read_payload(r, DIAGNOSTIC_MAX_BYTES as u32)?;
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
