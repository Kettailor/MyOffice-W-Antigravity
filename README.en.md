# 🏢 MyOffice-W-Antigravity — 3D Multi-Agent Office for Google Antigravity & Claude Code

[![CI](https://github.com/Kettailor/MyOffice-W-Antigravity/actions/workflows/ci.yml/badge.svg)](https://github.com/Kettailor/MyOffice-W-Antigravity/actions/workflows/ci.yml)
[![Online Demo](https://github.com/Kettailor/MyOffice-W-Antigravity/actions/workflows/pages.yml/badge.svg)](https://kettailor.github.io/MyOffice-W-Antigravity/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.9-339933?logo=node.js&logoColor=white)](package.json)

[Tiếng Việt](README.md) · **English** · [Architecture](docs/ARCHITECTURE.md) · [Multi-Agent Rules](AGENTS.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

**MyOffice-W-Antigravity** is a real-time interactive 3D office (Three.js + Next.js + Node.js SSE Server) where your **Google Antigravity** (and **Claude Code**) sessions come to work as 3D Chibi characters at their own desks: walking to the library to read files, typing code at their desks, visiting the server room to run terminal commands, spawning **Subagent** teammates connected by visual team lines, surfacing `implementation_plan.md` / `ask_question` prompts in a centered **Focus-to-Approve** modal, and celebrating completed tasks.

![MyOffice-W-Antigravity Demo](docs/media/demo.gif)

---

## 🙏 Original Author & Attribution

This project is built upon and extends the open-source project **[My Office (`khanh020905/my-office`)](https://github.com/khanh020905/my-office)**:

- **Original Author**: **[@khanh020905](https://github.com/khanh020905)**
- **Original Repository**: **[https://github.com/khanh020905/my-office](https://github.com/khanh020905/my-office)** (*"Văn phòng 3D cho các phiên Claude Code · A 3D office for your Claude Code sessions"*)
- **Google Antigravity Adaptation & Multi-Agent Architecture (`MyOffice-W-Antigravity`)**: **[@Kettailor](https://github.com/Kettailor)** — added the real-time `Antigravity Brain Watcher` (`server/antigravity.mjs`), the **Rust Native Engine** (`rust-native/`) & **Docker On-Demand Host Bridge** (`server/host-bridge.mjs`), parallel **Main Agent + 4 Subagents** orchestration (`AGENTS.md`), **Focus-to-Approve** modal for `ask_question` and `implementation_plan.md` feedback, **Task Dispatch (`📋 Give Work` with per-session AI Model selector, 20-photo drafts, inline session rename/pin) & 2-Channel Group Chat (`💼 Work` vs `💬 Watercooler`)**, dynamic **5h/7d Quota estimation** with per-project & multi-account breakdown, Windows NVIDIA GPU monitoring, and **SHA-256/HMAC** role-based remote access control (**Deputy Director 6-digit PIN** vs. **Assistant Director** workspace-scoped access in `server/access.mjs`).
- **Additional Credits**:
  - Runaway CPU/RAM and forgotten dev-server heuristics in `server/system.mjs` adapted from [Kanevry/cc-reaper](https://github.com/Kanevry/cc-reaper) (Apache-2.0).
  - Street vehicles built from [Kenney Car Kit 3.1](https://kenney.nl/assets/car-kit) (CC0).

> **Note**: This is an independent community project and is not affiliated with or endorsed by Google or Anthropic.

---

## ✨ Key Features

1. **Zero-Config Google Antigravity `Brain Watcher` (`server/antigravity.mjs`)**
   - Automatically watches `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`.
   - Maps every Antigravity tool (`read_file`, `write_file`, `edit_file`, `run_command`, `grep_search`, `search_web`, `invoke_subagent`, `ask_question`, etc.) to 3D character animations and stations.
   - Synchronizes `task.md` checklists (`- [ ]`, `- [/]`, `- [x]`) and background task logs in real time.

2. **Visual Multi-Agent Subagent Orchestration & Adaptive Chibi Pace**
   - When a Main Agent invokes subagents (`invoke_subagent`), the elevator immediately brings Chibi subagent characters into the office to brief with the Main Agent and connect via `team-lines.js`, with `deferMainAction` queuing to ensure the Main Agent never gets stuck when tasks finish rapidly.
   - **Adaptive Movement Speed (`calcPace`)**: Chibis in an active working session (`work` / `fire` / briefing) walk at an elevated pace to keep up with real-time tool interactions, returning to a calm normal walk when idle (`rest`).

3. **Focus-to-Approve Modal, Project Folder Manager, 4-Tab Todo Board & 2-Channel Group Chat**
   - Automatically brings up a centered decision modal when an agent calls `ask_question` or requests feedback on `implementation_plan.md`.
   - Built-in `📋 Give Work` (`Giao việc`) dialog with per-session/folder **AI Model selector** (`Gemini 4 Argon`, `Gemini 3.8 Flash`, `Claude Opus 5.5`, `Claude Sonnet 5.5`, `GPT-OSS 120B`), add project/create new folder directly in **New conversation**, remove project from workspace list without deleting disk files, inline session stop/rename/delete/pin, folder-grouped Session Rail view, and auto-saved drafts with up to **20 pasted images** (`IndexedDB`).
   - **4-Tab Todo Board (`📋 Todos`)**: Switch between **All**, **My Tasks** (device-local), **Agent Tasks** (synced from `task.md`), and **Shared Tasks** (real-time server-synced across all connected devices).
   - Dual-channel Group Chat separating **💼 Work Group** and **💬 Watercooler Chat** with 7-day rolling retention.

4. **Role-Based Remote Access Control (`server/access.mjs`), Session Control Permissions & SHA-256/HMAC Security**
   - **Deputy Director (`Phó Giám đốc`)**: Sign in from a secondary device/phone using the 6-digit PIN (hashed with SHA-256 + salt and signed via HMAC-SHA256) to get full visibility across all workspaces and the Co-Directors Office.
   - **Assistant Director (`Trợ lý Giám đốc`) & Session Controls (`sessionControl`)**: Register by name, wait for Director approval, and access permitted workspaces with configurable permissions to stop, rename, or delete sessions controllable from both Desktop and Mobile UI.

5. **Docker + Rust Native Engine + On-Demand Host Bridge & Dynamic 5h/7d Quota**
   - **Rust Native Engine (`rust-native/`)**: Accelerates Brain scanning, JSONL tailing, system telemetry (`sysinfo`), and SHA-256/HMAC security redaction.
   - **Docker & On-Demand Host Bridge (`:4311`)**: Runs the production server in Docker (`:4310`) paired with a lightweight watcher that wakes the Host Bridge on demand and auto-stops after 45s of inactivity.
   - Tracks CPU, RAM, disk, Windows NVIDIA GPU utilization, forgotten dev servers, and dynamic 5-hour / 7-day token quota across projects and accounts.

6. **MCP Management Hub (`🔌 MCP`) & Project File Manager (`📁 Project Files`)**
   - **4-Tab MCP Hub (`server/mcp.mjs` & `src/office/ui/mcp-drawer.js`)**: Manage all Model Context Protocol servers (`mcp_config.json`) with instant enable/disable toggles, batch actions, live connection testing (`ping`), 12 popular presets, custom `stdio`/`http` form with live JSON preview, raw JSON import/export, tool schema inspector, and automatic secret masking (`maskSecret`).
   - **Project File Manager & Live Document Viewer (`server/files.mjs` & `src/office/ui/file-manager.js`)**: Workspace-scoped file browser with built-in preview for Word (`.docx`), Excel (`.xlsx`, `.csv`), `.pdf`, images, media, inline code editor (`Ctrl+S`), file upload, folder creation, and one-click task dispatch with the selected file.
   - **Live AI Model Switcher & Quick Reply Bar**: Switch between 14 AI models (`Gemini 4 Argon`, `Gemini 3.8 Flash`, `Claude Opus 5.5`, `Claude Sonnet 5.5`, `GPT-OSS 120B`) and send follow-up instructions directly inside the `Session Drawer`, with live model badges on the `Session Rail`.
   - **3D Chibi Gender Customization (`👦 Male` / `👧 Female`)**: Select custom 3D Chibi gender for Director, Deputy Director, and Assistant Director profiles.

---

## 🚀 Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/Kettailor/MyOffice-W-Antigravity.git
cd MyOffice-W-Antigravity

# 2. Install dependencies
npm install

# 3. Start development server (http://localhost:4310)
npm run dev
```

Open **<http://localhost:4310>** to watch your live sessions, or **<http://localhost:4310/?demo>** to explore demo mode without any agents running.

### Docker + On-Demand Host Bridge (Recommended on Windows)

```bash
npm run docker:up
npm run docker:status
npm run docker:restart
npm run docker:down
```

### Production Build & CLI

```bash
npm run build
npm start

# Optional: install hooks & login service
node bin/cli.mjs install --service
node bin/cli.mjs doctor
```

---

## 🔒 Privacy & Security

- **Local-First**: Runtime state in `data/` (tokens, 6-digit PIN, access list, chat logs, replay logs, screenshots) is strictly git-ignored (`.gitignore`).
- **Automatic Redaction**: API keys, bearer tokens, GitHub tokens, and credentials in URLs are masked via `server/redact.mjs`.
- **Network Isolation**: Hooks are accepted from loopback (`127.0.0.1` / `::1`) only. External device access is restricted to trusted Wi-Fi (`OFFICE_WIFI_SSID`) and Tailscale (`100.64.0.0/10`) with rate-limited PIN authentication.

See [`SECURITY.md`](SECURITY.md) for the full security policy.

---

## 📄 License

Released under the **[MIT License](LICENSE)**.
- Original Copyright © 2026 **[khanh020905](https://github.com/khanh020905)** ([`khanh020905/my-office`](https://github.com/khanh020905/my-office)).
- Antigravity Adaptation Copyright © 2026 **[Kettailor](https://github.com/Kettailor)** ([`Kettailor/MyOffice-W-Antigravity`](https://github.com/Kettailor/MyOffice-W-Antigravity)).
