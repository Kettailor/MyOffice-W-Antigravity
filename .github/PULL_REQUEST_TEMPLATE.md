## Tóm tắt thay đổi (Summary)

<!-- Mô tả ngắn gọn thay đổi này giải quyết vấn đề gì cho người dùng văn phòng 3D -->

## Phân vùng mã nguồn tác động (Affected Subagent Domains)

- [ ] `world-3d-specialist` (`src/office/world/**`, `src/office/people/**`, `src/office/scene/**`)
- [ ] `ui-chat-specialist` (`src/office/ui/**`, `src/components/**`, `src/styles/**`, `src/i18n/**`)
- [ ] `backend-agy-specialist` (`server/**`, `bin/**`, `hooks/**`)
- [ ] `qa-test-specialist` (`tests/**`, `.github/workflows/**`)

## Danh sách kiểm tra bắt buộc (Checklist)

- [ ] Đã đồng bộ khóa dịch đa ngôn ngữ cả `vi` và `en` (`src/i18n/locales/`).
- [ ] Không chứa dữ liệu cá nhân, file trong `data/`, `.env`, địa chỉ MAC hoặc khóa nhạy cảm.
- [ ] Đã chạy `node scripts/module-map.mjs` nếu có thay đổi trong `src/office/`.
- [ ] Đã vượt qua toàn bộ kiểm tra: `npm run lint && npm run typecheck && npm test`.
