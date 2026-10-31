FROM node:22-alpine

RUN apk add --no-cache git && git config --system --add safe.directory '*'

WORKDIR /app

# Copy package manifests and install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source and prebuilt Next.js output
COPY . .

# Build Next.js only if a prebuilt .next folder is not present
RUN if [ ! -f .next/BUILD_ID ]; then npx next build; fi

ENV NODE_ENV=production
ENV OFFICE_HOST=0.0.0.0
ENV OFFICE_PORT=4310
ENV OFFICE_DOCKER=1
ENV OFFICE_HOST_BRIDGE=http://host.docker.internal:4311

EXPOSE 4310

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4310/health || exit 1

CMD ["node", "server/index.mjs"]
