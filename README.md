# 🏢 MyOffice-W-Antigravity — Văn phòng 3D & Web IDE Điều phối Multi-Agent cho Google Antigravity & Claude Code

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.9-339933?logo=node.js&logoColor=white)](package.json)
[![Version](https://img.shields.io/badge/Version-1.6.0-10b981)](package.json)

**Tiếng Việt** · [English](README.en.md) · [Kiến trúc Hệ thống](docs/ARCHITECTURE.md) · [Bảo mật](SECURITY.md) · [Đóng góp](CONTRIBUTING.md)

**MyOffice-W-Antigravity** là nền tảng văn phòng 3D trực quan theo thời gian thực kết hợp **Antigravity Web IDE** (Three.js + Next.js + Node.js SSE Server + Rust Native Engine), nơi mỗi phiên làm việc của **Google Antigravity** và **Claude Code** hóa thân thành một nhân vật Chibi 3D tại bàn làm việc riêng: tự động đọc tài liệu ở thư viện, gõ code tại bàn, chạy lệnh ở phòng server, triệu hồi đội ngũ **Subagent** nối dây nhóm trực quan, trình duyệt kế hoạch (`implementation_plan.md`) và bắn pháo hoa khi hoàn thành nhiệm vụ.

![MyOffice-W-Antigravity Demo](docs/media/demo.gif)

---

## 🙏 Tác giả Dự án Gốc & Ghi nhận Bản quyền (Credits & Attribution)

Dự án này được phát triển và mở rộng dựa trên nền tảng dự án mã nguồn mở gốc **[My Office (`khanh020905/my-office`)](https://github.com/khanh020905/my-office)**:

- **Tác giả dự án gốc (Original Author)**: **[@khanh020905](https://github.com/khanh020905)**
- **Kho lưu trữ gốc (Original Repository)**: **[https://github.com/khanh020905/my-office](https://github.com/khanh020905/my-office)** (*"Văn phòng 3D cho các phiên Claude Code · A 3D office for your Claude Code sessions"*)
- **Phát triển & Tích hợp hệ sinh thái Google Antigravity (`MyOffice-W-Antigravity`)**: **[@Kettailor](https://github.com/Kettailor)** — bổ sung bộ máy `Antigravity Brain Watcher` (`server/antigravity.mjs`), giao diện **Antigravity Web IDE** (`/antigravity`), nhân tăng tốc **Rust Native Engine** (`rust-native/`) & **Docker On-Demand Host Bridge** (`server/host-bridge.mjs`), sơ đồ **16 bàn (4 cụm) + Bàn Tràn Động (Overflow Hot-desks)**, hộp thoại duyệt nổi **Focus-to-Approve** (`ask_question` & `implementation_plan.md`), trung tâm **MCP Hub 4 tab** (`server/mcp.mjs`), **Trình Quản lý File Dự Án & Xem trước `.docx`/`.xlsx`/`.pdf`** (`server/files.mjs`), bảng **Giao việc đa mô hình & Nhóm Chat 2 kênh tách biệt**, thống kê **Hạn mức Kép (Dual Quota 5h/7d cho Gemini Ultra & Claude/GPT)**, giám sát GPU NVIDIA trên Windows và hệ thống phân quyền bảo mật **SHA-256 / HMAC-SHA256** cho **Phó Giám đốc (PIN 6 số) / Trợ lý Giám đốc** (`server/access.mjs`).
- **Trích dẫn kỹ thuật khác**:
  - Luật phát hiện tiến trình ngốn CPU/RAM và dev server bỏ quên trong `server/system.mjs` được tham khảo từ [Kanevry/cc-reaper](https://github.com/Kanevry/cc-reaper) (Apache-2.0).
  - Mô hình xe cộ trên đường phố sử dụng bộ [Kenney Car Kit 3.1](https://kenney.nl/assets/car-kit) (CC0).

> **Lưu ý**: Đây là dự án cộng đồng độc lập, không thuộc sở hữu hay đại diện chính thức của Google (Antigravity) hay Anthropic (Claude).

---

## ✨ Tính năng nổi bật

### 1. Tự động phát hiện & đồng bộ phiên Google Antigravity (`Brain Watcher`)
- Tự động quét thư mục `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` (và tự động bồi đắp dữ liệu đầy đủ từ `transcript_full.jsonl` khi nội dung bị rút gọn) mà không cần cấu hình thủ công.
- Mỗi cuộc hội thoại Antigravity đang mở là **một nhân vật Chibi 3D** có bàn làm việc riêng, biển tên phòng ban theo thư mục dự án (`Workspace`), hiển thị yêu cầu hiện tại và công cụ đang thực thi.
- **Không gian 4 Cụm Bàn Chính (16 bàn) & Bàn Tràn Động (`Overflow Hot-desks`)**: Khi số lượng phiên hoạt động vượt quá 16 bàn chính, hệ thống tự động phân bổ nhân vật sang các ghế trống tại phòng họp, bàn ăn hoặc thư viện và thu hồi ghế ngay khi phiên nghỉ.
- **Chế độ Tập trung (`Focus Mode`)**: Tự động giới hạn tốc độ dựng hình WebGL xuống `12 FPS` và giãn nhịp các tác vụ phụ khi mở bảng điều phối toàn màn hình, giúp tiết kiệm tối đa tài nguyên CPU/GPU.
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

### 2. Antigravity Web IDE Tích hợp (`/antigravity`)
- Cung cấp giao diện **Web IDE chuyên biệt** tại đường dẫn `/antigravity` đồng bộ thời gian thực với toàn bộ các phiên làm việc trên máy chủ.
- **Dòng thời gian hội thoại chi tiết (`Rich Conversation`)**: Xem đầy đủ câu lệnh của người dùng, ảnh đính kèm, chuỗi suy nghĩ (`Thinking steps`), danh sách công cụ đã gọi và bảng thống kê tệp thay đổi kèm số dòng thêm/xóa (`+added` / `-removed`).
- **Quản lý Brain Artifacts trực tiếp**: Đọc và chỉnh sửa trực tuyến `implementation_plan.md`, `task.md`, `walkthrough.md` với thứ tự ưu tiên thông minh và đồng bộ tức thì.
- **Cây thư mục Workspace & Trình xem đa năng**: Duyệt file dự án, sửa code trực tiếp, chuyển đổi mô hình AI và gửi lệnh mới ngay trên trình duyệt.

### 3. Điều phối Đội ngũ Subagent Trực quan & Tốc độ Chibi Thích ứng
- Khi Main Agent gọi `invoke_subagent`, thang máy được kích hoạt tức thì đưa nhân vật Chibi Subagent bước vào văn phòng, họp nhanh nhận việc từ Main Agent, nối dây nhóm (`team-lines.js`), di chuyển tới khu vực chuyên môn và báo cáo lại khi hoàn tất.
- **Tốc độ di chuyển thích ứng (`calcPace`)**: Nhân vật Chibi đang trong phiên làm việc (`work` / `fire` / họp nhóm) tự động di chuyển nhanh nhạy để theo kịp các bước công cụ thời gian thực, và trở lại dáng đi bộ thư thái khi nghỉ ngơi (`rest`).
- **Tùy chỉnh Giới tính Chibi 3D (`👦 Nam` / `👧 Nữ`)**: Hỗ trợ chọn giới tính nhân vật Chibi riêng cho Giám đốc, Phó Giám đốc và từng Trợ lý Giám đốc.

### 4. Hộp thoại `📋 Giao việc` Đa Mô hình, Bảng Kế hoạch 4 Tab & Nhóm Chat 2 Kênh
- **Giao việc nâng cao**: Hỗ trợ chọn **Mô hình AI (14 Models)** lưu riêng cho từng phiên/thư mục (`Gemini 4 Argon`, `Gemini 3.8 Flash`, `Claude Opus 5.5`, `Claude Sonnet 5.5`, `GPT-OSS 120B`...), thêm dự án & tạo thư mục mới ngay trong mục **Cuộc trò chuyện mới**, ghim phiên/dự án (`📌`), đổi tên phiên (`✏️`), dừng/xóa phiên (`⏹️` / `🗑️`), gửi chỉ thị nhanh trong ngăn chi tiết phiên và tự động lưu bản nháp kèm tối đa **20 ảnh** (`Ctrl+V` / `IndexedDB`).
- **Hộp thoại duyệt nổi `Focus-to-Approve`**: Khi Agent cập nhật `implementation_plan.md` có bật `RequestFeedback` hoặc gọi `ask_question`, giao diện tự động mở hộp thoại nổi giữa màn hình giúp duyệt kế hoạch hoặc chọn phương án trả lời ngay lập tức.
- **Bảng Kế hoạch (`📋 Việc cần làm`) 4 Chế độ**: Phân chia **Xem tất cả**, **Việc của tôi** (lưu trên thiết bị), **Việc của Agent** (tự động đồng bộ từ checklist `task.md`) và **Việc chung** (đồng bộ thời gian thực cho mọi thiết bị).
- **Nhóm Chat 2 kênh tách biệt**: Tách biệt hoàn toàn kênh **💼 Nhóm Công Việc** (giao việc, duyệt lệnh, báo cáo tiến độ) và **💬 Nhóm Tán Gẫu** (trò chuyện giải trí), tự động dọn dẹp theo chu kỳ 7 ngày.

### 5. Giám sát Hạn mức Kép (`Dual Quota 5h & 7d`), AI Credits & Phần cứng
- **Tách bạch Hạn mức theo Nhóm Mô hình**: Hiển thị độc lập thanh hạn mức 5 giờ và hạn mức tuần (7 ngày) cho cả 2 nhóm: **Google AI Ultra (Gemini)** và **Claude / GPT**.
- Hỗ trợ bật/tắt trực tiếp chế độ **AI Credits**, quản lý và tự động chuyển đổi đa tài khoản khi chạm ngưỡng hạn mức.
- Theo dõi thời gian thực CPU, RAM, ổ đĩa, tiến trình ngốn tài nguyên, dev server bỏ quên và hiệu suất GPU NVIDIA (`nvidia-smi`).

### 6. Trung tâm Quản lý MCP (`🔌 MCP Hub`) & Trình Quản lý File Dự Án (`📁 File Dự Án`)
- **Trung tâm Kết nối & Quản lý MCP (`server/mcp.mjs` & `src/office/ui/mcp-drawer.js`)**: Quản lý tập trung `mcp_config.json` với 4 tab (**Danh sách Server**, **Kho 12 Mẫu MCP phổ biến**, **Form cấu hình `stdio`/`http` kèm Live JSON Preview**, và **Trình sửa/nhập/xuất JSON**). Hỗ trợ nhập cả đoạn JSON rời (tự động suy luận tên server từ câu lệnh/gói/URL), kiểm tra kết nối trực tiếp (`ping`), khám phá danh sách tool/schema và tự động che khóa bí mật (`maskSecret`).
- **Trình Quản lý & Xem File Dự Án (`server/files.mjs` & `src/office/ui/file-manager.js`)**: Duyệt cây thư mục theo phân quyền Workspace, xem trực tiếp tài liệu Word (`.docx`), bảng tính Excel (`.xlsx`, `.csv`), `.pdf`, hình ảnh, video/audio, chỉnh sửa mã nguồn trực tuyến (`Ctrl+S`), tải file lên, tạo thư mục và giao việc trực tiếp kèm đường dẫn file.

### 7. Kiến trúc Docker + Rust Native Engine + On-Demand Host Bridge & Phân quyền Bảo mật
- **Rust Native Engine (`rust-native/`)**: Tăng tốc quét thư mục Brain, đọc luồng `transcript.jsonl`, thu thập thông số hệ thống (`sysinfo`) và khiên bảo mật `SHA-256/HMAC` + `redact`.
- **Docker & On-Demand Host Bridge (`:4311`)**: Chạy gọn nhẹ trong Docker container (`:4310`) kết hợp trình giám sát `work-office-native watch-bridge` chỉ đánh thức Host Bridge khi có tác vụ thực thi và tự nghỉ sau 45 giây nhàn rỗi.
- **Phân quyền 2 cấp (`Phó Giám đốc` vs. `Trợ lý Giám đốc`)**:
  - **Phó Giám đốc**: Đăng nhập từ thiết bị phụ/điện thoại bằng **mã PIN 6 số** (băm `SHA-256` kèm salt, ký phiên `HMAC-SHA256`), có Phòng Đồng Giám đốc và toàn quyền quan sát/điều phối mọi dự án.
  - **Trợ lý Giám đốc**: Đăng ký tên qua cổng truy cập; Giám đốc phê duyệt các `Workspace` được phép xem và cấp/thu hồi quyền dừng, đổi tên hoặc xóa phiên làm việc.

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

- Mở **<http://localhost:4310>** để vào Văn phòng 3D trực quan.
- Mở **<http://localhost:4310/antigravity>** để sử dụng giao diện **Antigravity Web IDE**.
- Mở **<http://localhost:4310/?demo>** để trải nghiệm chế độ mô phỏng mà không cần cài đặt Agent.

### Chạy bằng Docker + On-Demand Host Bridge (Khuyên dùng trên Windows)

```bash
# Khởi chạy toàn bộ Docker container (:4310) + On-Demand Host Bridge (:4311)
npm run docker:up
# Hoặc nhấp đúp file Start-WorkOffice.bat trên Windows

# Kiểm tra trạng thái Docker, Host Bridge và Rust Native Engine
npm run docker:status

# Khởi động lại hoặc dừng hoàn toàn (hoặc chạy Stop-WorkOffice.bat)
npm run docker:restart
npm run docker:down
```

### Chạy bản Production (Standalone Node) & Công cụ CLI

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

## 🔒 Bảo mật & Quyền Riêng tư (Privacy & Security)

Dự án tuân thủ nghiêm ngặt nguyên tắc **Local-First & Zero-Leak** (chi tiết tại [`SECURITY.md`](SECURITY.md)):

1. **Cô lập hoàn toàn dữ liệu thời gian thực**:
   - Toàn bộ thư mục `data/` (`access.json`, `pin`, `token`, `chat.json`, `state.json`, `limits.json`, `projects.json`, `totals.json`, `replay/*.jsonl`, `shots/`, `task-images/`, `*.log`) cùng các file `.env*`, `*.key`, `*.pem` đã được khóa chặt trong [`.gitignore`](.gitignore).
2. **Tự động che dấu khóa bí mật (`server/redact.mjs`)**:
   - Mọi chuỗi giống API Key, Bearer Token, GitHub Token (`ghp_...`), mật khẩu trong URL hoặc thông tin nhạy cảm đều được lọc qua `redact()` trước khi lưu log hoặc hiển thị lên giao diện.
3. **Cô lập Mạng & Kiểm soát Truy cập**:
   - Endpoint nhận hook chỉ chấp nhận kết nối từ chính máy cục bộ (`127.0.0.1` / `::1`).
   - Kết nối từ thiết bị ngoài chỉ hoạt động qua mạng Wi-Fi tin cậy (`OFFICE_WIFI_SSID`) hoặc mạng riêng ảo **Tailscale** (`100.64.0.0/10`), bảo vệ bằng mã PIN 6 số có khóa chống dò mật khẩu (rate-limit lockout).
4. **An toàn Tiến trình & Tệp tin**:
   - Chống leo thang đường dẫn (`Path Traversal`) bằng kiểm tra `realpathSync` trong phạm vi Workspace được cấp phép và giới hạn bộ nhớ giải nén khi xem trước tài liệu.
   - Mọi thao tác dọn dẹp tiến trình đều đối chiếu kép **PID + Thời điểm khởi chạy (`start time`)**.

---

## 🧪 Kiểm tra Chất lượng Mã nguồn

```bash
# Chạy toàn bộ bộ kiểm tra chất lượng
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
├── app/                     # Next.js App Router (Văn phòng 3D `/` & Antigravity Web IDE `/antigravity`)
├── bin/                     # Công cụ CLI (cli.mjs, service.mjs)
├── docs/                    # Tài liệu kiến trúc (ARCHITECTURE.md) & ảnh minh họa
├── hooks/                   # Hooks chuyển tiếp sự kiện & status-line
├── public/                  # Tài sản 3D, текстура, phương tiện giao thông, âm thanh
├── rust-native/             # Nhân tăng tốc Rust Native (Axum, Tokio, sysinfo, SHA-256/HMAC)
├── scripts/                 # Điều phối Docker (docker-ctl.mjs), build demo, smoke test, module map
├── server/                  # Máy chủ HTTP/SSE, Brain Watcher (antigravity.mjs), MCP, Files, Host Bridge, Phân quyền
├── src/
│   ├── components/          # Các thành phần React (TopBar, Stage, AntigravityIde, Drawers...)
│   ├── i18n/                # Từ điển đa ngôn ngữ đồng bộ 100% (Tiếng Việt & Tiếng Anh)
│   ├── office/              # Engine văn phòng 3D (Three.js: world, people, scene, ui, life...)
│   ├── shared/              # Bộ máy Nhóm Chat 2 kênh (chat-engine.js)
│   └── styles/              # Hệ thống CSS theo từng phân vùng giao diện
├── tests/                   # Unit tests (node --test) & E2E tests (Playwright)
├── Dockerfile               # Multi-stage build (Rust Alpine + Node 22 Alpine)
├── docker-compose.yml       # Cấu hình chạy container work-office & kết nối Host Bridge
├── Start-WorkOffice.bat     # Trình khởi chạy nhanh 1 chạm trên Windows
├── Stop-WorkOffice.bat      # Trình dừng nhanh Docker & Host Bridge trên Windows
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
