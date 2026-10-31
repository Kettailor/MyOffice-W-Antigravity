---
name: multi-agent-orchestrator
description: >-
  Quy trình điều phối Main Agent và 4 Subagent chuyên biệt (world-3d-specialist,
  ui-chat-specialist, backend-agy-specialist, qa-test-specialist) cho dự án Work Office.
  Kích hoạt skill này khi cần xử lý các yêu cầu đa tính năng hoặc tối ưu tốc độ thực thi song song.
---

# Quy trình Điều phối Main Agent & Subagent (`Work Office`)

Khi thực hiện các tác vụ phức tạp hoặc nhiều yêu cầu cùng lúc trên `e:\WorkOffice`, Main Agent sử dụng mô hình **Phân rã theo miền (Domain Decomposition)** và giao việc song song cho các Subagent.

## Bước 1: Định nghĩa Subagent (nếu chưa định nghĩa trong phiên hiện tại)

Sử dụng công cụ `define_subagent` để đăng ký 4 Subagent chuyên trách:
1. `world-3d-specialist` (`src/office/world/**`, `src/office/people/**`, `src/office/scene/**`, `src/office/core/**`, `src/office/life/**`)
2. `ui-chat-specialist` (`src/office/ui/**`, `src/components/**`, `src/styles/**`, `src/shared/**`, `src/i18n/**`)
3. `backend-agy-specialist` (`server/**`)
4. `qa-test-specialist` (`tests/**`)

## Bước 2: Giao việc Song song (`invoke_subagent`)

- Khi gọi `invoke_subagent`, luôn truyền `Prompt` cụ thể gồm:
  1. **Mục tiêu cần đạt**
  2. **Danh sách file được phép sửa** (tuyệt đối không chồng lấn với Subagent khác đang chạy song song)
  3. **Ràng buộc kỹ thuật** (ví dụ: giữ 60 FPS WebGL, đồng bộ `vi`/`en` i18n, không phá vỡ walking graph)
- Sau khi phát lệnh `invoke_subagent` song song, kết thúc lượt để hệ thống tự động đánh thức Main Agent ngay khi các Subagent hoàn thành (Reactive Wakeup, không cần polling).

## Bước 3: Kiểm chứng & Cập nhật Bản dựng (`QA & Build`)

Sau khi các Subagent hoàn tất:
1. Chạy `npm.cmd run typecheck ; npm.cmd run lint ; npm.cmd test ; npm.cmd run build`
2. Khởi động lại daemon `node server/index.mjs` nếu có thay đổi trong `server/**` hoặc bản build frontend.
