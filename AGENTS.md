# Kiến trúc Điều phối Main Agent & Subagent — Work Office (`e:\WorkOffice`)

Dự án **Work Office 3D** được thiết kế để vận hành theo mô hình **Main Agent (Orchestrator / Tech Lead)** kết hợp **4 Subagent chuyên biệt** chạy song song nhằm đạt tốc độ thực thi nhanh nhất, tiết kiệm ngữ cảnh (context window) và tránh xung đột file.

---

## 1. Vai trò của Main Agent (Orchestrator)

1. **Phân tích & Chia nhỏ công việc (Decompose)**:
   - Khi nhận yêu cầu từ Giám đốc / Phó Giám đốc / Trợ lý Giám đốc, Main Agent phân tách yêu cầu thành các gói công việc độc lập theo **4 phân vùng mã nguồn không chồng lấn** bên dưới.
2. **Khởi tạo & Điều phối Subagent song song (`define_subagent` + `invoke_subagent`)**:
   - Với các tác vụ chạm vào từ 2 phân vùng trở lên (ví dụ: vừa sửa 3D World, vừa sửa UI/Chat, vừa sửa Backend), Main Agent **khởi chạy đồng thời các Subagent trong cùng 1 lượt (parallel tool calls)**.
   - Với các tác vụ nhỏ chỉ sửa 1-2 file đơn giản, Main Agent có thể xử lý trực tiếp để tránh độ trễ khởi tạo.
3. **Tổng hợp & Kiểm증 cuối (`Build & Daemon Sync`)**:
   - Sau khi các Subagent hoàn tất và báo cáo kết quả, Main Agent rà soát tính nhất quán, chạy `qa-test-specialist` (hoặc `npm.cmd run build`) và khởi động lại daemon nếu cần.

---

## 2. Phân vùng 4 Subagent Chuyên biệt (File Ownership Boundaries)

Để các Subagent chạy song song tuyệt đối không ghi đè file của nhau, mỗi Subagent chỉ được phép chỉnh sửa các file trong phân vùng của mình:

| Tên Subagent (`TypeName`) | Vai trò (`Role`) | Phạm vi thư mục được phép ghi (`Write Scope`) | Khi nào kích hoạt |
| :--- | :--- | :--- | :--- |
| **`world-3d-specialist`** | `3D World & Chibi Engineer` | `src/office/world/**`, `src/office/people/**`, `src/office/scene/**`, `src/office/core/**`, `src/office/life/**`, `src/office/audio/**` | Thiết kế phòng ban 3D, bàn ghế, nhân vật Chibi, đường đi (`navigation.js`), âm thanh `sfx.js`, tối ưu FPS WebGL. |
| **`ui-chat-specialist`** | `UI, Group Chat & i18n Engineer` | `src/office/ui/**`, `src/components/**`, `src/styles/**`, `src/shared/**`, `src/i18n/**` | Sửa hộp thoại `📋 Giao việc`, Nhóm Chat, TopBar, Mac Drawer, Cài đặt, CSS và từ điển đa ngôn ngữ (`vi` + `en`). |
| **`backend-agy-specialist`** | `Backend & Antigravity Watcher Engineer` | `server/**` (`index.mjs`, `antigravity.mjs`, `access.mjs`, `tasks.mjs`, `sys.mjs`, `win-sys.ps1`) | Sửa máy chủ HTTP/SSE, đồng bộ Antigravity Brain/SQLite, Quota 5h/7d, phân quyền PIN/Trợ lý, mạng Wi-Fi `Ket` & Tailscale. |
| **`qa-test-specialist`** | `QA, Test & Build Verifier` | `tests/**` | Viết unit test trong `tests/*.test.mjs` và chạy kiểm tra `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd test`. |
| **`research`** *(Built-in)* | `Codebase Researcher` | *Chỉ đọc (Read-only)* | Khảo sát nhanh nhiều file hoặc tra cứu cấu trúc mã nguồn mà không làm đầy context của Main Agent. |

---

## 3. Quy chuẩn Kỹ thuật Bắt buộc cho Mọi Agent

1. **Đồng bộ Đa ngôn ngữ (`i18n`)**:
   - Mọi khóa dịch thêm vào `src/i18n/locales/vi/*.js` **bắt buộc** phải có khóa tương ứng trong `src/i18n/locales/en/*.js` (được kiểm tra tự động bởi `tests/i18n.test.mjs`).
2. **Bảo mật Mạng & Phân quyền**:
   - Kết nối mạng ngoài chỉ cho phép Wi-Fi SSID `Ket` và mạng `Tailscale` (`100.64.0.0/10`), không mở qua Ethernet LAN.
   - Thiết bị đăng nhập bằng mã PIN 6 số là **Phó Giám đốc** (`isDirectorDevice: true`, thấy toàn bộ Workspace); người dùng đăng ký qua tên là **Trợ lý Giám đốc** (chỉ thấy Workspace được cấp phép, ẩn mục Máy tính `#btn-mac`).
3. **Hiển thị Subagent Trực quan trong Mô hình 3D**:
   - Khi Main Agent gọi `invoke_subagent`, `server/antigravity.mjs` tự động phát sự kiện `substart` / `agent` / `substop` để văn phòng 3D sinh nhân vật Chibi Subagent nối dây nhóm (`team-lines.js`) với bàn của Main Agent.
