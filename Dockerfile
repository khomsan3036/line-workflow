# ==========================================================================
# LINE Workflow App - production image
#
#   docker build -t line-workflow-app:latest .
#   (จาก Mac Apple Silicon ไป Windows/x64 ต้องระบุ --platform linux/amd64
#    ใช้ offline-bundle.sh จะจัดการให้อัตโนมัติ)
#
# 2 stage: builder คอมไพล์ TypeScript, runtime มีเฉพาะ dependencies ที่ต้องใช้ตอนรัน
# ==========================================================================

# ---------- stage 1: build ----------
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---------- stage 2: runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    TZ=Asia/Bangkok \
    PORT=3000
WORKDIR /app

# ติดตั้งเฉพาะ production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# โค้ดที่ build แล้ว + ไฟล์ที่โปรแกรมอ่านตอนรัน
#   dist/    โค้ด JS + EJS views (copy-views ใส่ไว้ที่ dist/src/views)
#   public/  โลโก้และไฟล์คงที่ (express.static อ่านจาก process.cwd()/public)
#   sql/     สคริปต์สร้างตาราง (db-setup หาที่ process.cwd()/sql)
COPY --from=builder /app/dist ./dist
COPY public ./public
COPY sql ./sql

# โฟลเดอร์เก็บไฟล์จากไลน์กลุ่ม (mount เป็น volume ใน compose)
RUN mkdir -p /app/storage/media /app/reports /app/logs \
 && chown -R node:node /app

USER node
EXPOSE 3000

# /health ตอบ 200 เมื่อต่อฐานข้อมูลได้ (500 ถ้าไม่ได้ - container ยังรันอยู่แต่แสดง unhealthy)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/src/index.js"]
