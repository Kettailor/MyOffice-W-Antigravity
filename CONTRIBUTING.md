# Hướng dẫn Đóng góp (Contributing to MyOffice-W-Antigravity)

Cảm ơn bạn đã quan tâm và đóng góp cho **MyOffice-W-Antigravity**! Tài liệu này hướng dẫn quy trình từ lúc clone dự án đến khi gửi Pull Request.

> **Ghi nhận**: Dự án này kế thừa kiến trúc từ **[My Office (`khanh020905/my-office`)](https://github.com/khanh020905/my-office)** của tác giả **[@khanh020905](https://github.com/khanh020905)** và mở rộng tích hợp sâu cho hệ sinh thái **Google Antigravity**.

---

## 1. Thiết lập Môi trường (Set up)

Yêu cầu: **Node.js 20.9 trở lên**, `npm` và trình duyệt hỗ trợ WebGL trên Windows, macOS hoặc Linux.

```bash
git clone https://github.com/Kettailor/MyOffice-W-Antigravity.git
cd MyOffice-W-Antigravity
npm install
npm run dev          # Chạy tại http://localhost:4310 với Turbopack & Hot Reload
```

- Mở <http://localhost:4310/?demo> để xem văn phòng với các dự án giả lập mà không cần chạy Antigravity hay Claude Code.
- Các tham số URL hữu ích khi phát triển:
  - `?layout=pro` hoặc `?layout=cozy`: Chọn sơ đồ mặt bằng.
  - `?at=12:10`: Giả lập thời gian trong ngày (ví dụ giờ nghỉ trưa).
  - `?season=noel|tet|halloween`: Hiển thị trang trí theo mùa lễ hội.
  - `?debug`: Mở `window.__office` trong DevTools Console để kiểm tra draw calls và trạng thái 3D.

---

## 2. Các Lệnh Kiểm tra & Build (Scripts)

| Lệnh | Chức năng |
| :--- | :--- |
| `npm run dev` | Chạy máy chủ + Next.js ở chế độ phát triển (Turbopack, hot reload) tại cổng `OFFICE_PORT` (mặc định `4310`). |
| `npm run build` | Đóng gói bản Production của giao diện Next.js. |
| `npm start` | Chạy máy chủ Production (cần chạy `npm run build` trước). |
| `npm run lint` | Kiểm tra quy chuẩn mã nguồn bằng ESLint. |
| `npm run typecheck` | Kiểm tra kiểu dữ liệu TypeScript (`tsc --noEmit`). |
| `npm test` | Chạy toàn bộ Unit Test (`node --test`). |
| `npm run smoke` | Kiểm thử khói đa nền tảng (khởi chạy server thật, kiểm tra `/health`, `/event`, `/api/sys`, `cli.mjs install`). |
| `npm run test:e2e` | Chạy kiểm thử trình duyệt thực tế bằng Playwright. |
| `node scripts/module-map.mjs` | Cập nhật bảng Module Map trong `docs/ARCHITECTURE.md` (`--check` dùng trên CI). |

Hệ thống **GitHub Actions CI** (`.github/workflows/ci.yml`) tự động chạy tất cả các lệnh trên đối với mọi Pull Request.

---

## 3. Cấu trúc Mã nguồn & Phân vùng Subagent

Trước khi chỉnh sửa, hãy đọc **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** và **[AGENTS.md](AGENTS.md)**:

- **Không gian 3D & Nhân vật Chibi** (`world-3d-specialist`): `src/office/world/`, `src/office/people/`, `src/office/scene/`, `src/office/core/`, `src/office/life/`.
- **Giao diện, Nhóm Chat & Đa ngôn ngữ** (`ui-chat-specialist`): `src/office/ui/`, `src/components/`, `src/styles/`, `src/i18n/`.
- **Máy chủ Backend & Antigravity Brain Watcher** (`backend-agy-specialist`): `server/index.mjs`, `server/antigravity.mjs`, `server/access.mjs`, `server/tasks.mjs`, `server/system.mjs`, `server/platform/`.
- **Kiểm thử Tự động** (`qa-test-specialist`): `tests/unit/*.test.mjs`, `tests/e2e/*.spec.ts`.

---

## 4. Quy tắc Kỹ thuật Bắt buộc (Rules for Contributors)

1. **Giữ vững hiệu năng 60 FPS WebGL**:
   - Kiểm tra số lượng draw calls trước và sau khi thêm đồ vật 3D (`__office.renderer.info.render.calls`).
   - Các mesh tĩnh sẽ tự động được gộp (`core/optimize.js`); bất kỳ mesh nào chuyển động, nhấp nháy hoặc đổi màu động phải gắn `userData.noMerge = true`.
2. **Đồng bộ Đa ngôn ngữ (`vi` & `en`)**:
   - Không viết cứng chuỗi giao diện trực tiếp trong code. Hãy thêm khóa vào cả `src/i18n/locales/en/<area>.js` và `src/i18n/locales/vi/<area>.js`, sau đó gọi `tr('area.key')` hoặc `t('area.key')`.
   - Bài test `tests/unit/i18n.test.mjs` sẽ báo lỗi trên CI nếu thiếu khóa dịch hoặc lệch cấu trúc giữa các ngôn ngữ.
3. **Bảo mật & Không Đẩy Dữ liệu Riêng tư**:
   - Tuyệt đối không commit bất kỳ file nào trong `data/`, `.env`, thông tin tài khoản máy cá nhân, địa chỉ MAC hoặc khóa bí mật.
   - Mọi dữ liệu hiển thị lên UI phải đi qua `redact()` (`server/redact.mjs`).
4. **Cập nhật Module Map & Kiểm thử**:
   - Nếu bạn thêm, xóa hoặc sửa dòng trong `src/office/**/*.js`, hãy chạy `node scripts/module-map.mjs` để đồng bộ bảng trong `docs/ARCHITECTURE.md`.
   - Chạy đầy đủ bộ lệnh trước khi tạo Pull Request:
     ```bash
     npm run lint && npm run typecheck && npm test && node scripts/module-map.mjs --check
     ```

---

## 5. Quy chuẩn Gửi Pull Request

- Mỗi Pull Request tập trung giải quyết một chủ đề rõ ràng, kèm mô tả ngắn gọn về thay đổi.
- Đính kèm ảnh chụp màn hình (screenshot) hoặc GIF nếu có thay đổi về giao diện 3D / UI.
- Đảm bảo toàn bộ pipeline CI xanh trước khi yêu cầu review.
