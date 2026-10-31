# Chính sách Bảo mật & Quyền Riêng tư (Security & Privacy Policy)

**MyOffice-W-Antigravity** vận hành trực tiếp trên máy tính cá nhân của người dùng để giám sát và điều phối các phiên làm việc của Google Antigravity và Claude Code. Do đó, bảo mật dữ liệu cục bộ (Local-First) và kiểm soát truy cập mạng được đặt làm ưu tiên hàng đầu.

---

## 1. Các Phiên bản Được Hỗ trợ (Supported Versions)

| Phiên bản | Trạng thái Hỗ trợ Bảo mật |
| :--- | :--- |
| `1.x` (`main`) | ✅ Được hỗ trợ tích cực |

---

## 2. Luật Bảo vệ Dữ liệu Riêng tư & Không Đẩy lên GitHub (Zero-Leak Policy)

1. **Cô lập Thư mục Dữ liệu Thời gian thực (`data/`)**:
   - Toàn bộ dữ liệu sinh ra khi chạy ứng dụng được lưu trong `data/` và bị chặn tuyệt đối bởi `.gitignore`:
     - `data/pin`: Mã PIN 6 số dùng cho thiết bị phụ / Phó Giám đốc.
     - `data/token`: Khóa phiên truy cập cục bộ.
     - `data/access.json`: Danh sách thành viên từ xa, cookie định danh (`office_member`), quyền hạn Workspace và hàng đợi duyệt việc.
     - `data/chat.json` & `data/task-images/`: Lịch sử trao đổi Nhóm Chat và hình ảnh đính kèm khi giao việc.
     - `data/state.json`, `data/limits.json`, `data/projects.json`, `data/totals.json`: Trạng thái phiên làm việc và thống kê token.
     - `data/replay/*.jsonl`, `data/shots/`, `data/*.log`: Nhật ký phát lại (giữ tối đa 7 ngày), ảnh chụp màn hình và log máy chủ.
2. **Che dấu Thông tin Nhạy cảm Tự động (`server/redact.mjs`)**:
   - Mọi văn bản hiển thị lên giao diện hoặc lưu vào nhật ký đều đi qua bộ lọc `redact()` để tự động che:
     - Bearer Token, API Key (`sk-...`, `AIza...`), GitHub Personal Access Token (`ghp_...`, `github_pat_...`).
     - Thông tin xác thực nhúng trong URL (`https://user:pass@host`) và các biến môi trường nhạy cảm.
3. **Biến Môi trường (`.env`)**:
   - Không lưu trữ SSID cá nhân, địa chỉ MAC phần cứng, IP nội bộ hoặc khóa bí mật trực tiếp trong mã nguồn công khai. Mọi tùy chỉnh cá nhân sử dụng biến môi trường (`OFFICE_PORT`, `OFFICE_WIFI_SSID`, `OFFICE_WIFI_MAC`, `OFFICE_DATA_DIR`, `OFFICE_LANG`).

---

## 3. Luật Bảo mật Mạng & Phân quyền Truy cập

1. **Chỉ Nhận Hook từ Loopback (`127.0.0.1` / `::1`)**:
   - Các đường dẫn `/event`, `/hook/permission`, `/hook/question` chỉ chấp nhận yêu cầu từ chính máy đang chạy server (`isLoopback`). Mọi yêu cầu từ mạng ngoài hoặc qua Cloudflare Tunnel tới các đường dẫn này đều bị từ chối.
2. **Giới hạn Giao diện Mạng Ngoài (Wi-Fi Tin cậy & Tailscale)**:
   - Khi bật chia sẻ mạng nội bộ, hệ thống chỉ cho phép kết nối qua Wi-Fi được cấu hình (`OFFICE_WIFI_SSID`) và dải IP **Tailscale** (`100.64.0.0/10`), không mở tràn lan qua cáp Ethernet LAN công cộng.
3. **Phân quyền 2 Cấp (`Phó Giám đốc` vs. `Trợ lý Giám đốc`)**:
   - **Phó Giám đốc (`isDirectorDevice: true`)**: Yêu cầu nhập đúng mã PIN 6 số (tự động khóa IP 15 phút nếu nhập sai 5 lần; khóa toàn bộ cổng PIN nếu sai 20 lần trong 15 phút).
   - **Trợ lý Giám đốc**: Phải được Giám đốc phê duyệt thủ công, chỉ nhìn thấy các `Workspace` được cấp phép (`allowedWorkspaces`), bị ẩn bảng quản lý phần cứng máy chủ (`#btn-mac`) và mọi yêu cầu giao việc đều phải qua cổng duyệt của Giám đốc (`requireTaskApproval`).
4. **Kiểm tra Kép khi Dừng Tiến trình (`PID + Start Time`)**:
   - Trước khi gửi tín hiệu dừng bất kỳ tiến trình hoặc dev server nào, `server/system.mjs` luôn kiểm tra lại cả `PID` lẫn **thời điểm khởi chạy (`start time`)** để đảm bảo không bao giờ tắt nhầm tiến trình mới được hệ điều hành cấp lại PID cũ.

---

## 4. Báo cáo Lỗ hổng Bảo mật (Reporting a Vulnerability)

Nếu bạn phát hiện bất kỳ cách nào có thể vượt qua cơ chế kiểm tra loopback, mã PIN, phân quyền Workspace hoặc lộ lọt dữ liệu nhạy cảm:
- **Vui lòng KHÔNG mở Issue công khai.**
- Hãy báo cáo riêng tư thông qua tính năng **[GitHub Private Vulnerability Reporting](https://github.com/Kettailor/MyOffice-W-Antigravity/security/advisories/new)** của kho lưu trữ hoặc liên hệ trực tiếp với chủ sở hữu **[@Kettailor](https://github.com/Kettailor)**.
- Chúng tôi sẽ phản hồi trong vòng 48 giờ và phát hành bản vá sớm nhất có thể.
