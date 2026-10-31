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
- **Google Antigravity Adaptation & Multi-Agent Architecture (`MyOffice-W-Antigravity`)**: **[@Kettailor](https://github.com/Kettailor)** — added the real-time `Antigravity Brain Watcher` (`server/antigravity.mjs`), parallel **Main Agent + 4 Subagents** orchestration (`AGENTS.md`), **Focus-to-Approve** modal for `ask_question` and `implementation_plan.md` feedback, **Task Dispatch (`📋 Giao việc`) & Group Chat**, dynamic **5h/7d Quota estimation** with per-project breakdown, Windows NVIDIA GPU monitoring, and role-based remote access control (**Deputy Director 6-digit PIN** vs. **Assistant Director** workspace-scoped access in `server/access.mjs`).
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

2. **Visual Multi-Agent Subagent Orchestration**
   - When a Main Agent invokes subagents (`invoke_subagent`), the 3D office spawns Chibi subagent characters connected via `team-lines.js` to the Main Agent's desk.

3. **Focus-to-Approve Modal & Group Chat Task Dispatch**
   - Automatically brings up a centered decision modal when an agent calls `ask_question` or requests feedback on `implementation_plan.md`.
   - Built-in `📋 Give Work` (`Giao việc`) dialog and multi-project Group Chat.

4. **Role-Based Remote Access Control (`server/access.mjs`)**
   - **Deputy Director (`Phó Giám đốc`)**: Sign in from a secondary device/phone using the 6-digit PIN to get full visibility across all workspaces.
   - **Assistant Director (`Trợ lý Giám đốc`)**: Register by name, wait for Director approval, and access only permitted workspaces with pre-execution task approval.

5. **Machine Health, NVIDIA GPU & Dynamic 5h/7d Quota**
   - Tracks CPU, RAM, disk, Windows NVIDIA GPU utilization, forgotten dev servers, and dynamic 5-hour / 7-day token quota across projects.

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
