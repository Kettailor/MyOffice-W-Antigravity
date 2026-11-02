use axum::{
    extract::Json as AxumJson,
    routing::{get, post},
    Router,
};
use hmac::{Hmac, Mac};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;
use sysinfo::{Disks, System};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

type HmacSha256 = Hmac<Sha256>;

#[derive(Serialize, Clone)]
struct BrainCandidate {
    #[serde(rename = "convId")]
    conv_id: String,
    #[serde(rename = "convDir")]
    conv_dir: String,
    #[serde(rename = "transcriptFile")]
    transcript_file: String,
    #[serde(rename = "mtimeMs")]
    mtime_ms: u64,
    #[serde(rename = "birthtimeMs")]
    birthtime_ms: u64,
    size: u64,
}

#[derive(Serialize)]
struct TailOutput {
    ok: bool,
    #[serde(rename = "nextOffset")]
    next_offset: u64,
    size: u64,
    #[serde(rename = "mtimeMs")]
    mtime_ms: u64,
    lines: Vec<String>,
}

#[derive(Serialize)]
struct LinuxMemInfo {
    total: u64,
    available: u64,
    #[serde(rename = "swapTotal")]
    swap_total: u64,
    #[serde(rename = "swapFree")]
    swap_free: u64,
    pressure: String,
}

#[derive(Serialize)]
struct Win32ProcRow {
    i: u32,
    pp: u32,
    n: String,
    x: String,
    c: String,
    w: u64,
    t: u64,
    s: u64,
    se: u32,
}

#[derive(Serialize)]
struct Win32TcpRow {
    l: u16,
    s: u8,
    o: u32,
}

#[derive(Serialize)]
struct Win32ReadingOutput {
    p: Vec<Win32ProcRow>,
    fa: u64,
    fu: u64,
    t: Vec<Win32TcpRow>,
}

#[derive(Serialize)]
struct SecurityCapabilities {
    #[serde(rename = "hmacBridge")]
    hmac_bridge: bool,
    #[serde(rename = "sha256Pin")]
    sha256_pin: bool,
    #[serde(rename = "networkGuard")]
    network_guard: &'static str,
    #[serde(rename = "secretRedaction")]
    secret_redaction: bool,
}

#[derive(Serialize)]
struct HealthOutput {
    ok: bool,
    engine: &'static str,
    runtime: &'static str,
    version: &'static str,
    arch: &'static str,
    os: &'static str,
    security: SecurityCapabilities,
}

#[derive(Serialize)]
struct DiskTelemetry {
    mount: String,
    total: u64,
    available: u64,
    used: u64,
}

#[derive(Serialize)]
struct NativeSysTelemetry {
    ok: bool,
    engine: &'static str,
    runtime: &'static str,
    version: &'static str,
    mem: HashMap<&'static str, u64>,
    cpu: HashMap<&'static str, f32>,
    disks: Vec<DiskTelemetry>,
    #[serde(rename = "processCount")]
    process_count: usize,
}

#[derive(Deserialize)]
struct RedactRequest {
    text: Option<String>,
}

#[derive(Serialize)]
struct RedactResponse {
    ok: bool,
    redacted: String,
}

#[derive(Deserialize, Default)]
struct BridgeWakeupSignal {
    #[serde(rename = "requestedAt", default)]
    requested_at: u64,
}

#[cfg(windows)]
mod win_ffi {
    #[repr(C)]
    #[derive(Default, Copy, Clone)]
    pub struct FileTime {
        pub low: u32,
        pub high: u32,
    }
    impl FileTime {
        pub fn to_u64(self) -> u64 {
            ((self.high as u64) << 32) | (self.low as u64)
        }
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn GetProcessTimes(
            h: *mut std::ffi::c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn CloseHandle(h: *mut std::ffi::c_void) -> i32;
        fn ProcessIdToSessionId(pid: u32, session_id: *mut u32) -> i32;
        fn FreeConsole() -> i32;
    }

    pub fn detach_console() {
        unsafe {
            let _ = FreeConsole();
        }
    }

    pub fn proc_times_and_session(pid: u32) -> (u64, u32) {
        unsafe {
            let mut session_id: u32 = 1;
            let _ = ProcessIdToSessionId(pid, &mut session_id);
            let h = OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if h.is_null() {
                return (0, session_id);
            }
            let mut creation = FileTime::default();
            let mut exit = FileTime::default();
            let mut kernel = FileTime::default();
            let mut user = FileTime::default();
            let ok = GetProcessTimes(h, &mut creation, &mut exit, &mut kernel, &mut user);
            let _ = CloseHandle(h);
            if ok != 0 {
                (kernel.to_u64().saturating_add(user.to_u64()), session_id)
            } else {
                (0, session_id)
            }
        }
    }
}

fn time_to_ms(t: std::io::Result<std::time::SystemTime>) -> u64 {
    t.ok()
        .and_then(|st| st.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(250)).is_ok()
}

fn resolve_workspace_root(explicit_arg: Option<&str>) -> PathBuf {
    if let Some(arg) = explicit_arg {
        let p = PathBuf::from(arg);
        if p.join("server").join("host-bridge.mjs").is_file() {
            return p;
        }
    }
    if let Ok(env_root) = env::var("OFFICE_ROOT") {
        let p = PathBuf::from(env_root);
        if p.join("server").join("host-bridge.mjs").is_file() {
            return p;
        }
    }
    if let Ok(cwd) = env::current_dir() {
        if cwd.join("server").join("host-bridge.mjs").is_file() {
            return cwd;
        }
    }
    if let Ok(exe) = env::current_exe() {
        let mut cur = exe.parent().map(|p| p.to_path_buf());
        while let Some(dir) = cur {
            if dir.join("server").join("host-bridge.mjs").is_file() {
                return dir;
            }
            cur = dir.parent().map(|p| p.to_path_buf());
        }
    }
    env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn find_node_binary() -> String {
    if let Ok(bin) = env::var("OFFICE_NODE_BIN") {
        if Path::new(&bin).is_file() {
            return bin;
        }
    }
    #[cfg(windows)]
    {
        let candidates = [
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Program Files (x86)\nodejs\node.exe",
        ];
        for c in candidates {
            if Path::new(c).is_file() {
                return c.to_string();
            }
        }
        "node.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        "node".to_string()
    }
}

fn ensure_host_bridge(root_dir: &Path, bridge_port: u16) -> bool {
    if port_open(bridge_port) {
        return true;
    }
    let script = root_dir.join("server").join("host-bridge.mjs");
    if !script.is_file() {
        return false;
    }
    let node_bin = find_node_binary();
    let mut cmd = std::process::Command::new(node_bin);
    cmd.arg(&script)
        .arg("--on-demand")
        .current_dir(root_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().is_ok()
}

fn write_watcher_heartbeat(watcher_file: &Path, bridge_port: u16) {
    let payload = serde_json::json!({
        "ok": true,
        "pid": std::process::id(),
        "port": bridge_port,
        "mode": "on-demand",
        "at": now_epoch_ms(),
    });
    if let Ok(txt) = serde_json::to_string(&payload) {
        let _ = fs::write(watcher_file, txt);
    }
}

/// Ultra-lightweight (~1.5 MB RAM, ~0% CPU) background watcher on Windows Host.
/// Checks `data/bridge-wakeup.json` every 250ms and spawns `node server/host-bridge.mjs --on-demand`
/// with `CREATE_NO_WINDOW` only when a task is dispatched from the Docker container.
fn watch_bridge_loop(root_dir: PathBuf, bridge_port: u16) {
    #[cfg(windows)]
    win_ffi::detach_console();

    let lock_addr = SocketAddr::from(([127, 0, 0, 1], 4313));
    let lock_listener = match std::net::TcpListener::bind(lock_addr) {
        Ok(l) => {
            let _ = l.set_nonblocking(true);
            l
        }
        Err(_) => {
            // Another watch-bridge instance is already active on 127.0.0.1:4313
            return;
        }
    };

    let data_dir = env::var("OFFICE_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root_dir.join("data"));
    let _ = fs::create_dir_all(&data_dir);

    let wakeup_file = data_dir.join("bridge-wakeup.json");
    let stop_flag = data_dir.join(".bridge-stopped");
    let watcher_file = data_dir.join("bridge-watcher.json");

    write_watcher_heartbeat(&watcher_file, bridge_port);

    let mut last_spawn_ms: u64 = 0;
    let mut ticks: u64 = 0;

    loop {
        if stop_flag.is_file() {
            let _ = fs::remove_file(&watcher_file);
            break;
        }

        ticks = ticks.wrapping_add(1);
        if ticks % 40 == 0 {
            write_watcher_heartbeat(&watcher_file, bridge_port);
        }

        let mut wakeup_triggered = false;
        while let Ok((_stream, _)) = lock_listener.accept() {
            wakeup_triggered = true;
        }

        if wakeup_file.is_file() {
            let now = now_epoch_ms();
            let requested_at = fs::read_to_string(&wakeup_file)
                .ok()
                .and_then(|raw| {
                    let clean = raw.trim_start_matches('\u{feff}').trim();
                    serde_json::from_str::<BridgeWakeupSignal>(clean).ok()
                })
                .map(|s| s.requested_at)
                .filter(|&ts| ts > 0)
                .unwrap_or_else(|| {
                    fs::metadata(&wakeup_file)
                        .map(|m| time_to_ms(m.modified()))
                        .unwrap_or(now)
                });

            if now.saturating_sub(requested_at) <= 60_000 {
                wakeup_triggered = true;
            } else {
                let _ = fs::remove_file(&wakeup_file);
            }
        }

        if wakeup_triggered {
            let now = now_epoch_ms();
            if port_open(bridge_port) {
                let _ = fs::remove_file(&wakeup_file);
            } else if now.saturating_sub(last_spawn_ms) >= 2500 {
                let _ = fs::remove_file(&wakeup_file);
                if ensure_host_bridge(&root_dir, bridge_port) {
                    last_spawn_ms = now;
                }
            }
        }

        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

/// Fast native directory scanner for ~/.gemini/antigravity/brain/*
/// Replaces hundreds of individual Node.js `fsp.readdir` + `fsp.stat` promises per cycle.
fn scan_brain_dirs(dirs: &[String]) -> Vec<BrainCandidate> {
    let mut by_id: HashMap<String, BrainCandidate> = HashMap::new();

    for dir_str in dirs {
        let brain_path = Path::new(dir_str);
        let entries = match fs::read_dir(brain_path) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if !file_type.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let conv_dir: PathBuf = entry.path();
            let transcript_path = conv_dir
                .join(".system_generated")
                .join("logs")
                .join("transcript.jsonl");

            let meta = match fs::metadata(&transcript_path) {
                Ok(m) if m.is_file() && m.len() > 0 => m,
                _ => continue,
            };

            let mtime_ms = time_to_ms(meta.modified());
            let birthtime_ms = {
                let b = time_to_ms(meta.created());
                if b > 0 {
                    b
                } else {
                    mtime_ms
                }
            };
            let size = meta.len();

            let should_insert = match by_id.get(&name) {
                None => true,
                Some(prev) => {
                    mtime_ms > prev.mtime_ms || (mtime_ms == prev.mtime_ms && size > prev.size)
                }
            };

            if should_insert {
                by_id.insert(
                    name.clone(),
                    BrainCandidate {
                        conv_id: name,
                        conv_dir: conv_dir.to_string_lossy().into_owned(),
                        transcript_file: transcript_path.to_string_lossy().into_owned(),
                        mtime_ms,
                        birthtime_ms,
                        size,
                    },
                );
            }
        }
    }

    let mut list: Vec<BrainCandidate> = by_id.into_values().collect();
    list.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    list
}

/// Zero-GC byte-offset tail reader for Antigravity `transcript.jsonl`.
fn tail_transcript(path_str: &str, offset: u64) -> TailOutput {
    let path = Path::new(path_str);
    let meta = match fs::metadata(path) {
        Ok(m) if m.is_file() => m,
        _ => {
            return TailOutput {
                ok: false,
                next_offset: offset,
                size: 0,
                mtime_ms: 0,
                lines: Vec::new(),
            }
        }
    };

    let size = meta.len();
    let mtime_ms = time_to_ms(meta.modified());
    if size <= offset {
        return TailOutput {
            ok: true,
            next_offset: size,
            size,
            mtime_ms,
            lines: Vec::new(),
        };
    }

    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => {
            return TailOutput {
                ok: false,
                next_offset: offset,
                size,
                mtime_ms,
                lines: Vec::new(),
            }
        }
    };

    let read_len = (size - offset).min(8_000_000) as usize;
    let start_pos = if size - offset > 8_000_000 {
        size - 8_000_000
    } else {
        offset
    };

    if file.seek(SeekFrom::Start(start_pos)).is_err() {
        return TailOutput {
            ok: false,
            next_offset: offset,
            size,
            mtime_ms,
            lines: Vec::new(),
        };
    }

    let mut buf = vec![0u8; read_len];
    let n = match file.read(&mut buf) {
        Ok(n) => n,
        Err(_) => 0,
    };
    buf.truncate(n);

    if let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') {
        let next_offset = start_pos + (last_nl as u64) + 1;
        let text = String::from_utf8_lossy(&buf[..last_nl]);
        let mut lines: Vec<String> = text
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if start_pos > offset && !lines.is_empty() {
            lines.remove(0);
        }
        TailOutput {
            ok: true,
            next_offset,
            size,
            mtime_ms,
            lines,
        }
    } else {
        TailOutput {
            ok: true,
            next_offset: offset,
            size,
            mtime_ms,
            lines: Vec::new(),
        }
    }
}

fn read_linux_mem() -> LinuxMemInfo {
    let info = fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let psi = fs::read_to_string("/proc/pressure/memory").unwrap_or_default();

    let parse_kb = |key: &str| -> u64 {
        for line in info.lines() {
            if let Some(rest) = line.strip_prefix(key) {
                let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
                if let Ok(v) = digits.parse::<u64>() {
                    return v * 1024;
                }
            }
        }
        0
    };

    let total = parse_kb("MemTotal:");
    let avail = {
        let a = parse_kb("MemAvailable:");
        if a > 0 {
            a
        } else {
            parse_kb("MemFree:")
        }
    };
    let swap_total = parse_kb("SwapTotal:");
    let swap_free = parse_kb("SwapFree:");

    let left = if total > 0 {
        (avail as f64) / (total as f64)
    } else {
        1.0
    };

    let parse_psi = |prefix: &str| -> f64 {
        for line in psi.lines() {
            if line.starts_with(prefix) {
                for part in line.split_whitespace() {
                    if let Some(val) = part.strip_prefix("avg10=") {
                        if let Ok(v) = val.parse::<f64>() {
                            return v;
                        }
                    }
                }
            }
        }
        0.0
    };

    let some = parse_psi("some");
    let full = parse_psi("full");
    let pressure = if !psi.is_empty() {
        if full >= 5.0 || some >= 30.0 {
            "critical"
        } else if some >= 10.0 {
            "warn"
        } else {
            "normal"
        }
    } else if left < 0.08 {
        "critical"
    } else if left < 0.18 {
        "warn"
    } else {
        "normal"
    };

    LinuxMemInfo {
        total,
        available: avail,
        swap_total,
        swap_free,
        pressure: pressure.to_string(),
    }
}

/// Native Windows / cross-platform process & swap snapshot compatible with `parseReading()` in `server/platform/win32.mjs`.
/// Eliminates spawning heavy `powershell.exe Get-CimInstance` processes on Windows.
fn read_win32_snapshot() -> Win32ReadingOutput {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_processes();

    let mut procs = Vec::with_capacity(sys.processes().len());
    for (pid, proc_info) in sys.processes() {
        let pid_u32 = pid.as_u32();
        if pid_u32 == 0 {
            continue;
        }
        let name = proc_info.name().to_string();
        if name.eq_ignore_ascii_case("System Idle Process") {
            continue;
        }
        let ppid = proc_info.parent().map(|p| p.as_u32()).unwrap_or(0);
        let exe = proc_info
            .exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let cmd_slice = proc_info.cmd();
        let cmd = if cmd_slice.is_empty() {
            name.clone()
        } else {
            cmd_slice.join(" ")
        };
        let mem_bytes = proc_info.memory();
        let start_sec = proc_info.start_time();

        #[cfg(windows)]
        let (cpu_100ns, session_id) = win_ffi::proc_times_and_session(pid_u32);
        #[cfg(not(windows))]
        let (cpu_100ns, session_id) = ((proc_info.cpu_usage() as u64) * 100_000, 1u32);

        procs.push(Win32ProcRow {
            i: pid_u32,
            pp: ppid,
            n: name,
            x: exe,
            c: cmd,
            w: mem_bytes,
            t: cpu_100ns,
            s: start_sec,
            se: session_id,
        });
    }

    let fa_mb = sys.total_swap() / (1024 * 1024);
    let fu_mb = sys.used_swap() / (1024 * 1024);

    Win32ReadingOutput {
        p: procs,
        fa: fa_mb,
        fu: fu_mb,
        t: Vec::new(),
    }
}

fn redact_rules() -> &'static Vec<(Regex, &'static str)> {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    RULES.get_or_init(|| {
        vec![
            (Regex::new(r"(?i)(\bbearer\s+)[^\s\x22']+").unwrap(), "${1}•••"),
            (Regex::new(r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}").unwrap(), "•••"),
            (Regex::new(r"\bgh[pousr]_[A-Za-z0-9]{10,}").unwrap(), "•••"),
            (Regex::new(r"\bxox[abpr]-[A-Za-z0-9-]{10,}").unwrap(), "•••"),
            (
                Regex::new(r"\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}").unwrap(),
                "•••",
            ),
            (
                Regex::new(
                    r"(?i)(\b(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|pwd|authorization|cookie)\b[\x22']?\s*[:=]\s*[\x22']?)[^\s\x22'&]+",
                )
                .unwrap(),
                "${1}•••",
            ),
            (Regex::new(r"(//)[^\s/:@]+:[^\s/@]+@").unwrap(), "${1}•••@"),
            (
                Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b").unwrap(),
                "•••",
            ),
            (Regex::new(r"[A-Za-z0-9+_-]{32,}={0,2}").unwrap(), "•••"),
        ]
    })
}

fn redact_text(input: &str) -> String {
    let mut acc = input.to_string();
    for (re, rep) in redact_rules() {
        acc = re.replace_all(&acc, *rep).into_owned();
    }
    acc
}

fn hash_pin_sha256(pin: &str, salt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{}:{}", salt, pin).as_bytes());
    hex::encode(hasher.finalize())
}

#[allow(dead_code)]
fn sign_hmac_sha256(payload: &str, secret: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(payload.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn build_health() -> HealthOutput {
    HealthOutput {
        ok: true,
        engine: "work-office-native-rust",
        runtime: "axum-tokio",
        version: env!("CARGO_PKG_VERSION"),
        arch: env::consts::ARCH,
        os: env::consts::OS,
        security: SecurityCapabilities {
            hmac_bridge: true,
            sha256_pin: true,
            network_guard: "Ket+Tailscale",
            secret_redaction: true,
        },
    }
}

fn build_native_sys_telemetry() -> NativeSysTelemetry {
    let mut sys = System::new_all();
    sys.refresh_all();

    let mut mem = HashMap::new();
    mem.insert("total", sys.total_memory());
    mem.insert("used", sys.used_memory());
    mem.insert("available", sys.available_memory());
    mem.insert("swapTotal", sys.total_swap());
    mem.insert("swapUsed", sys.used_swap());

    let mut cpu = HashMap::new();
    cpu.insert("cores", sys.cpus().len() as f32);
    cpu.insert("globalUsage", sys.global_cpu_info().cpu_usage());

    let disks_info = Disks::new_with_refreshed_list();
    let disks: Vec<DiskTelemetry> = disks_info
        .list()
        .iter()
        .map(|d| {
            let total = d.total_space();
            let avail = d.available_space();
            DiskTelemetry {
                mount: d.mount_point().to_string_lossy().into_owned(),
                total,
                available: avail,
                used: total.saturating_sub(avail),
            }
        })
        .collect();

    NativeSysTelemetry {
        ok: true,
        engine: "work-office-native-rust",
        runtime: "axum-tokio",
        version: env!("CARGO_PKG_VERSION"),
        mem,
        cpu,
        disks,
        process_count: sys.processes().len(),
    }
}

async fn run_axum_server(port: u16) {
    let next_static = ServeDir::new(".next/static");
    let public_dir = ServeDir::new("public");

    let app = Router::new()
        .route("/health", get(|| async { AxumJson(build_health()) }))
        .route(
            "/api/sys/native",
            get(|| async { AxumJson(build_native_sys_telemetry()) }),
        )
        .route(
            "/api/security/redact",
            post(|AxumJson(payload): AxumJson<RedactRequest>| async move {
                let raw = payload.text.unwrap_or_default();
                AxumJson(RedactResponse {
                    ok: true,
                    redacted: redact_text(&raw),
                })
            }),
        )
        .nest_service("/_next/static", next_static)
        .fallback_service(public_dir)
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    println!(
        "[work-office-native] Axum + Tokio HTTP engine v{} listening on http://{}",
        env!("CARGO_PKG_VERSION"),
        addr
    );
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind Rust Axum server port");
    axum::serve(listener, app)
        .await
        .expect("Axum server error");
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("--health");

    match cmd {
        "--scan-brain" => {
            let dirs = if args.len() > 2 {
                &args[2..]
            } else {
                &[][..]
            };
            let out = scan_brain_dirs(dirs);
            println!(
                "{}",
                serde_json::to_string(&out).unwrap_or_else(|_| "[]".to_string())
            );
        }
        "--tail-transcript" => {
            let file = args.get(2).map(|s| s.as_str()).unwrap_or("");
            let offset = args
                .get(3)
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            let out = tail_transcript(file, offset);
            println!(
                "{}",
                serde_json::to_string(&out).unwrap_or_else(|_| "{}".to_string())
            );
        }
        "--sys-linux-mem" => {
            let out = read_linux_mem();
            println!(
                "{}",
                serde_json::to_string(&out).unwrap_or_else(|_| "{}".to_string())
            );
        }
        "--sys-win32" => {
            let out = read_win32_snapshot();
            println!(
                "{}",
                serde_json::to_string(&out).unwrap_or_else(|_| "{}".to_string())
            );
        }
        "--redact" => {
            let input = if args.len() > 2 {
                args[2..].join(" ")
            } else {
                String::new()
            };
            println!("{}", redact_text(&input));
        }
        "--hash-pin" => {
            let pin = args.get(2).map(|s| s.as_str()).unwrap_or("");
            let salt = args
                .get(3)
                .map(|s| s.as_str())
                .unwrap_or("work-office-salt");
            println!("{}", hash_pin_sha256(pin, salt));
        }
        "watch-bridge" | "--watch-bridge" => {
            let root_dir = resolve_workspace_root(args.get(2).map(|s| s.as_str()));
            let bridge_port = env::var("OFFICE_BRIDGE_PORT")
                .ok()
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(4311);
            watch_bridge_loop(root_dir, bridge_port);
        }
        "ensure-bridge" | "--ensure-bridge" => {
            let root_dir = resolve_workspace_root(args.get(2).map(|s| s.as_str()));
            let bridge_port = env::var("OFFICE_BRIDGE_PORT")
                .ok()
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(4311);
            let ok = ensure_host_bridge(&root_dir, bridge_port);
            println!(
                "{}",
                serde_json::json!({ "ok": ok, "port": bridge_port })
            );
        }
        "--server" => {
            let port = args
                .get(2)
                .and_then(|s| s.parse::<u16>().ok())
                .or_else(|| {
                    env::var("OFFICE_RUST_PORT")
                        .ok()
                        .and_then(|s| s.parse::<u16>().ok())
                })
                .unwrap_or(4312);
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("Failed to initialize Tokio runtime");
            rt.block_on(run_axum_server(port));
        }
        _ => {
            let out = build_health();
            println!(
                "{}",
                serde_json::to_string(&out).unwrap_or_else(|_| "{}".to_string())
            );
        }
    }
}
