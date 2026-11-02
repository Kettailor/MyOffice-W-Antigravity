# Stage 1: Build Native Rust Engine (Axum + Tokio + sysinfo + SHA-256/HMAC Security Shield)
FROM rust:alpine AS rust-builder
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY rust-native/Cargo.toml ./Cargo.toml
COPY rust-native/src ./src
RUN cargo build --release && strip target/release/work-office-native

# Stage 2: Lightweight Production Runtime (Alpine Linux + Rust Native + Node.js)
FROM node:22-alpine

RUN apk add --no-cache git && git config --system --add safe.directory '*'

WORKDIR /app

# Copy compiled Rust native engine from builder stage
COPY --from=rust-builder /build/target/release/work-office-native /usr/local/bin/work-office-native
RUN chmod +x /usr/local/bin/work-office-native

# Copy package manifests and install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source and prebuilt Next.js output
COPY . .
RUN mkdir -p /app/bin && cp /usr/local/bin/work-office-native /app/bin/work-office-native

# Build Next.js only if a prebuilt .next folder is not present
RUN if [ ! -f .next/BUILD_ID ]; then npx next build; fi

ENV NODE_ENV=production
ENV OFFICE_HOST=0.0.0.0
ENV OFFICE_PORT=4310
ENV OFFICE_DOCKER=1
ENV OFFICE_HOST_BRIDGE=http://host.docker.internal:4311
ENV WORK_OFFICE_NATIVE_BIN=/usr/local/bin/work-office-native

EXPOSE 4310

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4310/health || exit 1

CMD ["node", "server/index.mjs"]
