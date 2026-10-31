# 🏢 MyOffice-W-Antigravity — Văn phòng 3D Điều phối Multi-Agent cho Google Antigravity & Claude Code

[![CI](https://github.com/Kettailor/MyOffice-W-Antigravity/actions/workflows/ci.yml/badge.svg)](https://github.com/Kettailor/MyOffice-W-Antigravity/actions/workflows/ci.yml)
[![Online Demo](https://github.com/Kettailor/MyOffice-W-Antigravity/actions/workflows/pages.yml/badge.svg)](https://kettailor.github.io/MyOffice-W-Antigravity/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.9-339933?logo=node.js&logoColor=white)](package.json)

**Tiếng Việt** · [English](README.en.md) · [Kiến trúc Hệ thống](docs/ARCHITECTURE.md) · [Quy tắc Multi-Agent](AGENTS.md) · [Bảo mật](SECURITY.md) · [Đóng góp](CONTRIBUTING.md)

**MyOffice-W-Antigravity** là không gian văn phòng 3D trực quan theo thời gian thực (Three.js + Next.js + Node.js SSE Server), nơi mỗi phiên làm việc của **Google Antigravity** (và **Claude Code**) hóa thân thành một nhân vật Chibi 3D tại bàn làm việc riêng: tự động đọc tài liệu ở thư viện, gõ code tại bàn, chạy lệnh ở phòng server, triệu hồi đội ngũ **Subagent** nối dây nhóm trực quan, trình duyệt kế hoạch (`implementation_plan.md`) và bắn pháo hoa khi hoàn thành nhiệm vụ.

![MyOffice-W-Antigravity Demo](docs/media/demo.gif)

---

## 🙏 Tác giả Dự án Gốc & Ghi nhận Bản quyền (Credits & Attribution)

Dự án này được phát triển và mở rộng dựa trên nền tảng dự án mã nguồn mở gốc **[My Office (`khanh020905/my-office`)](https://github.com/khanh020905/my-office)**:

- **Tác giả dự án gốc (Original Author)**: **[@khanh020905](https://github.com/khanh020905)**
- **Kho lưu trữ gốc (Original Repository)**: **[https://github.com/khanh020905/my-office](https://github.com/khanh020905/my-office)** (*"Văn phòng 3D cho các phiên Claude Code · A 3D office for your Claude Code sessions"*)
- **Phát triển & Tích hợp hệ sinh thái Google Antigravity (`MyOffice-W-Antigravity`)**: **[@Kettailor](https://github.com/Kettailor)** — bổ sung bộ máy `Antigravity Brain Watcher` (`server/antigravity.mjs`), kiến trúc điều phối **Main Agent + 4 Subagents song song** (`AGENTS.md`), hộp thoại duyệt nổi **Focus-to-Approve** (`ask_question` & `implementation_plan.md`), bảng **Giao việc & Nhóm Chat đa dự án**, thống kê **Quota 5h/7d động** theo từng dự án, giám sát GPU NVIDIA trên Windows và hệ thống phân quyền **Phó Giám đốc (PIN 6 số) / Trợ lý Giám đốc** (`server/access.mjs`).
- **Trích dẫn kỹ thuật khác**:
  - Luật phát hiện tiến trình ngốn CPU/RAM và dev server bỏ quên trong `server/system.mjs` được tham khảo từ [Kanevry/cc-reaper](https://github.com/Kanevry/cc-reaper) (Apache-2.0).
  - Mô hình xe cộ trên đường phố sử dụng bộ [Kenney Car Kit 3.1](https://kenney.nl/assets/car-kit) (CC0).

> **Lưu ý**: Đây là dự án cộng đồng độc lập, không thuộc sở hữu hay đại diện chính thức của Google (Antigravity) hay Anthropic (Claude).

---

## ✨ Tính năng nổi bật

### 1. Tự động phát hiện & đồng bộ phiên Google Antigravity (`Brain Watcher`)
- Tự động quét thư mục `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` mà không cần cấu hình thủ công.
- Mỗi cuộc hội thoại Antigravity đang mở là **một nhân vật Chibi 3D** có bàn làm việc riêng, biển tên phòng ban theo thư mục dự án (`Workspace`), hiển thị yêu cầu hiện tại và công cụ đang thực thi.
- Ánh xạ toàn bộ hệ công cụ của Antigravity sang hành động 3D sống động:
  | Công cụ Antigravity | Hành động trong Văn phòng 3D |
  | :--- | :--- |
  | `read_file`, `view_file_outline`, `list_dir` | Đọc tài liệu tại bàn / Giá sách thư viện |
  | `write_file`, `edit_file`, `multi_replace_file_content` | Gõ code tại bàn làm việc |
  | `run_command`, `manage_task`, `send_command_input` | Chạy lệnh tại Phòng Server / Terminal |
  | `grep_search`, `find_by_name` | Tra cứu hồ sơ tại Thư viện |
  | `search_web`, `read_url_content`, `search_marketplace` | Tra cứu thông tin trên Web |
  | `invoke_subagent`, `define_subagent`, `send_message` | Sinh nhân vật Chibi **Subagent** nối dây nhóm (`team-lines.js`) với Main Agent |
  | `ask_question`, `implementation_plan.md` (`RequestFeedback: true`) | Giơ tay xin ý kiến & bật hộp thoại duyệt nổi **Focus-to-Approve** |

### 2. Kiến trúc Điều phối Multi-Agent (`Main Agent` + `4 Subagents`)
- Hỗ trợ hiển thị trực quan mô hình **Orchestrator (Tech Lead)** gọi song song 4 Subagent chuyên biệt (`world-3d-specialist`, `ui-chat-specialist`, `backend-agy-specialist`, `qa-test-specialist`).
- Khi Main Agent gọi `invoke_subagent`, văn phòng 3D lập tức sinh nhân vật Chibi Subagent bước vào cửa, nhận việc từ bàn Main Agent, di chuyển tới khu vực chuyên môn và báo cáo lại khi hoàn tất.

### 3. Đồng bộ Artifacts (`task.md`, `implementation_plan.md` & `walkthrough.md`)
- Tự động đọc checklist `- [ ]` / `- [/]` / `- [x]` từ file `task.md` trong thư mục brain của phiên và hiển thị trực tiếp trong ngăn kéo chi tiết của nhân vật.
- Khi Agent tạo hoặc cập nhật `implementation_plan.md` có bật `RequestFeedback`, hoặc gọi `ask_question`, giao diện tự động mở hộp thoại nổi giữa màn hình (**Focus-to-Approve**) giúp Giám đốc xem tóm tắt kế hoạch và chọn phương án trả lời ngay lập tức.

### 4. Hộp thoại `📋 Giao việc` & Nhóm Chat Điều hành
- Giao việc trực tiếp cho dự án đang mở hoặc khởi tạo nhiệm vụ mới kèm hình ảnh minh họa.
- Phòng họp & Nhóm Chat hiển thị luồng hội thoại giữa Giám đốc, Phó Giám đốc, Trợ lý Giám đốc và các Agent phụ trách từng dự án.

### 5. Phân quyền Truy cập Từ xa (`Phó Giám đốc` vs. `Trợ lý Giám đốc`)
- **Chính chủ Giám đốc (Thiết bị phụ / Điện thoại)**: Đăng nhập bằng **mã PIN 6 số** tạo trên máy chính để nhận vai trò **Phó Giám đốc** (`isDirectorDevice: true`), có nhân vật Chibi riêng và toàn quyền quan sát/điều phối mọi dự án.
- **Trợ lý Giám đốc (Cộng tác viên từ xa)**: Đăng ký tên và vai trò qua trang cổng truy cập; sau khi được Giám đốc phê duyệt sẽ chỉ nhìn thấy các `Workspace` được cấp phép, ẩn bảng điều khiển phần cứng máy chủ (`#btn-mac`) và mọi lệnh giao việc đều qua bước Giám đốc kiểm duyệt.

### 6. Giám sát Tài nguyên Máy tính, GPU & Quota 5h/7d
- Theo dõi thời gian thực CPU, RAM, ổ đĩa, GPU NVIDIA (`nvidia-smi` trên Windows), các dev server bị bỏ quên và dung lượng RAM của từng tiến trình Antigravity (`language_server`) / Claude.
- Ước tính động hạn mức sử dụng **Quota 5 giờ & 7 ngày** cùng biểu đồ phân bổ theo từng dự án và Phòng Truyền Thống (Trophy Cabinet).

---

## 🚀 Cài đặt & Sử dụng nhanh

### Yêu cầu hệ thống
- **Node.js**: `>= 20.9`
- **Hệ điều hành**: Windows, macOS hoặc Linux
- **Trình duyệt**: Hỗ trợ WebGL (Chrome, Edge, Safari, Firefox)

### Khởi chạy trong 1 phút

```bash
# 1. Clone kho lưu trữ
git clone https://github.com/Kettailor/MyOffice-W-Antigravity.git
cd MyOffice-W-Antigravity

# 2. Cài đặt dependencies
npm install

# 3. Chạy ngay chế độ phát triển (Turbopack + Hot Reload tại http://localhost:4310)
npm run dev
```

Mở trình duyệt tại **<http://localhost:4310>** để xem các phiên Antigravity thực tế trên máy của bạn, hoặc mở **<http://localhost:4310/?demo>** để trải nghiệm chế độ mô phỏng mà không cần cài đặt Agent.

### Chạy bản Production & Cài đặt Dịch vụ nền

```bash
# Build bản production và khởi chạy server tại http://localhost:4310
npm run build
npm start

# Cài đặt hooks và dịch vụ khởi động cùng hệ điều hành
node bin/cli.mjs install --service

# Kiểm tra sức khỏe hệ thống (Node, Server, Hooks, Service)
node bin/cli.mjs doctor

# Xem hoặc tạo mới mã PIN 6 số cho thiết bị di động / Phó Giám đốc
node bin/cli.mjs pin
node bin/cli.mjs pin --new
```

| Lệnh CLI (`node bin/cli.mjs ...`) | Chức năng |
| :--- | :--- |
| `install [--service] [--lan] [--no-approve] [--no-status]` | Cài đặt hooks kết nối Agent và tùy chọn đăng ký dịch vụ chạy nền khi đăng nhập (`Startup` trên Windows, `launchd` trên macOS, `systemd` trên Linux). |
| `uninstall` | Gỡ bỏ toàn bộ hooks và dịch vụ nền, khôi phục nguyên trạng file cấu hình cũ. |
| `doctor` | Chẩn đoán trạng thái Node.js, cổng máy chủ `:4310`, hooks và dịch vụ nền. |
| `start [--lan]` | Build (nếu chưa có) và chạy máy chủ Production trong terminal hiện tại. |
| `pin [--new]` | Hiển thị mã PIN 6 số hiện tại; thêm `--new` để đổi mã PIN và đăng xuất các thiết bị từ xa. |

---

## 🤖 Luật Điều phối Multi-Agent (`AGENTS.md`)

Kho lưu trữ đi kèm quy chuẩn điều phối **Main Agent & 4 Subagent chuyên biệt** tại [`AGENTS.md`](AGENTS.md) và kỹ năng [`.agents/skills/multi-agent-orchestrator/SKILL.md`](.agents/skills/multi-agent-orchestrator/SKILL.md). Khi làm việc trên dự án này, các Subagent được phân vùng quyền ghi file tách biệt hoàn toàn để chạy song song không xung đột:

| Tên Subagent (`TypeName`) | Vai trò (`Role`) | Phạm vi thư mục được phép ghi (`Write Scope`) |
| :--- | :--- | :--- |
| **`world-3d-specialist`** | `3D World & Chibi Engineer` | `src/office/world/**`, `src/office/people/**`, `src/office/scene/**`, `src/office/core/**`, `src/office/life/**`, `src/office/audio/**` |
| **`ui-chat-specialist`** | `UI, Group Chat & i18n Engineer` | `src/office/ui/**`, `src/components/**`, `src/styles/**`, `src/shared/**`, `src/i18n/**` |
| **`backend-agy-specialist`** | `Backend & Antigravity Watcher Engineer` | `server/**` (`index.mjs`, `antigravity.mjs`, `access.mjs`, `tasks.mjs`, `system.mjs`, `platform/**`) |
| **`qa-test-specialist`** | `QA, Test & Build Verifier` | `tests/**` |

---

## 🔒 Luật Bảo mật & Dữ liệu Riêng tư (Privacy & Security Rules)

Dự án tuân thủ nghiêm ngặt nguyên tắc **Local-First & Zero-Leak** (chi tiết tại [`SECURITY.md`](SECURITY.md)):

1. **Không bao giờ đẩy dữ liệu cá nhân/nhạy cảm lên Git**:
   - Toàn bộ thư mục `data/` (`access.json`, `pin`, `token`, `chat.json`, `state.json`, `limits.json`, `projects.json`, `totals.json`, `replay/*.jsonl`, `shots/`, `task-images/`, `*.log`) cùng các file `.env*`, `*.key`, `*.pem`, `*.tsbuildinfo` đã được khóa chặt trong [`.gitignore`](.gitignore).
2. **Tự động che dấu khóa bí mật (`server/redact.mjs`)**:
   - Mọi chuỗi giống API Key, Bearer Token, GitHub Token (`ghp_...`), mật khẩu trong URL hoặc thông tin nhạy cảm đều được lọc qua `redact()` trước khi lưu log hoặc hiển thị lên giao diện.
3. **Cô lập Mạng & Kiểm soát Truy cập**:
   - Endpoint nhận hook chỉ chấp nhận kết nối từ chính máy cục bộ (`127.0.0.1` / `::1`).
   - Kết nối từ thiết bị ngoài chỉ hoạt động khi được bật chủ động qua mạng Wi-Fi tin cậy (`OFFICE_WIFI_SSID`) hoặc mạng riêng ảo **Tailscale** (`100.64.0.0/10`), bảo vệ bằng mã PIN 6 số có khóa chống dò mật khẩu (rate-limit lockout).
4. **An toàn Tiến trình**:
   - Mọi thao tác dọn dẹp tiến trình đều đối chiếu kép **PID + Thời điểm khởi chạy (`start time`)** để không bao giờ tắt nhầm tiến trình khác.

---

## 🧪 Kiểm thử & CI/CD

Dự án được trang bị hệ thống **GitHub Actions CI/CD** tự động trong `.github/workflows/`:
- **[`ci.yml`](.github/workflows/ci.yml)**:
  - Kiểm tra ESLint (`npm run lint`), TypeScript (`npm run typecheck`), 27+ bài kiểm thử đơn vị (`npm test`), đồng bộ bản đồ kiến trúc (`node scripts/module-map.mjs --check`) và build Next.js trên **Node.js 20 & 22**.
  - Chạy kiểm thử đa nền tảng (`npm run smoke`) trên cả 3 hệ điều hành: **Ubuntu Linux**, **Windows** và **macOS**.
  - Chạy kiểm thử trình duyệt thực tế đầu-cuối với **Playwright** (`npm run test:e2e:smoke`).
- **[`pages.yml`](.github/workflows/pages.yml)**:
  - Tự động đóng gói bản tĩnh đa ngôn ngữ (`scripts/build-demo.mjs`) và xuất bản lên **GitHub Pages** sau mỗi lần cập nhật nhánh `main`.

```bash
# Chạy toàn bộ bộ kiểm tra chất lượng trước khi commit
npm run lint
npm run typecheck
npm test
node scripts/module-map.mjs --check
npm run build
npm run smoke
```

---

## 📂 Cấu trúc Thư mục

```text
MyOffice-W-Antigravity/
├── .agents/skills/          # Kỹ năng điều phối Multi-Agent cho Antigravity
├── .github/                 # Workflows CI/CD (ci.yml, pages.yml) & Issue/PR Templates
├── app/                     # Next.js App Router (layout, page, icons, metadata)
├── bin/                     # Công cụ CLI (cli.mjs, service.mjs)
├── docs/                    # Tài liệu kiến trúc (ARCHITECTURE.md) & ảnh minh họa
├── hooks/                   # Hooks chuyển tiếp sự kiện & status-line
├── public/                  # Tài sản 3D, текстура, phương tiện giao thông, âm thanh
├── scripts/                 # Công cụ build demo tĩnh, smoke test, cập nhật module map
├── server/                  # Máy chủ HTTP/SSE, Brain Watcher (antigravity.mjs), Phân quyền (access.mjs)
├── src/
│   ├── components/          # Các thành phần giao diện React (TopBar, Stage, Drawers...)
│   ├── i18n/                # Từ điển đa ngôn ngữ đồng bộ (Tiếng Việt & Tiếng Anh)
│   ├── office/              # Engine văn phòng 3D (Three.js: world, people, scene, ui, life...)
│   └── styles/              # Hệ thống CSS theo từng phân vùng giao diện
├── tests/                   # Unit tests (node --test) & E2E tests (Playwright)
├── AGENTS.md                # Luật điều phối Main Agent & 4 Subagent chuyên biệt
├── CODE_OF_CONDUCT.md       # Quy tắc ứng xử cộng đồng
├── CONTRIBUTING.md          # Hướng dẫn đóng góp mã nguồn
├── LICENSE                  # Giấy phép MIT (khanh020905 & Kettailor)
└── SECURITY.md              # Chính sách bảo mật & báo cáo lỗ hổng
```

---

## 📄 Giấy phép (License)

Phát hành dưới giấy phép **[MIT License](LICENSE)**.
- Bản quyền gốc © 2026 **[khanh020905](https://github.com/khanh020905)** ([`khanh020905/my-office`](https://github.com/khanh020905/my-office)).
- Bản quyền mở rộng & tích hợp Antigravity © 2026 **[Kettailor](https://github.com/Kettailor)** ([`Kettailor/MyOffice-W-Antigravity`](https://github.com/Kettailor/MyOffice-W-Antigravity)).
