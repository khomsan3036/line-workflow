#!/usr/bin/env bash
# ==========================================================================
# offline-bundle.sh - build image แล้วแพ็กทุกอย่างที่ต้องใช้ deploy บน Windows Server
#                     ที่ไม่มีอินเทอร์เน็ต (หรือไม่อยากให้ดึง image เอง)
#
#   ./offline-bundle.sh                 # image line-workflow-app:latest -> offline-bundle/line-workflow-app.zip
#   ./offline-bundle.sh v1.2.0          # ระบุ tag เอง -> image :v1.2.0, โฟลเดอร์/zip ชื่อ line-workflow-app_v1.2.0
#   SKIP_POSTGRES=1 ./offline-bundle.sh # ไม่รวม image postgres (ใช้ฐานข้อมูลที่มีอยู่แล้ว)
#
# ชื่อ bundle ไม่มีวันที่ (ดูวันที่ build ได้ใน MANIFEST.txt) จะได้ใช้ชื่อไฟล์เดิมทุกครั้งที่ deploy
# และบนเครื่องปลายทาง .env ไม่ต้องแก้ APP_IMAGE ทุกรอบ (คงเป็น line-workflow-app:latest)
#
# ผลลัพธ์อยู่ใน offline-bundle/line-workflow-app/ (หรือ line-workflow-app_<tag>/ เมื่อระบุ tag)
#   images.tar.gz             image ของ app (+ postgres) สำหรับ docker load
#   docker-compose.prod.yml   compose สำหรับรันบนเครื่องปลายทาง
#   .env.example              ต้นแบบไฟล์ config
#   load-and-run.ps1          สคริปต์ PowerShell: โหลด image + up -d
#   load-and-run.bat          แบบเดียวกันสำหรับ Command Prompt (ไม่ต้องยุ่งกับ ExecutionPolicy)
#   README-DEPLOY.md          ขั้นตอน deploy ทีละข้อ
# และไฟล์ zip ของโฟลเดอร์นั้น สำหรับก๊อปลง USB / แชร์ไดรฟ์
#
# ข้อควรรู้: Windows Server รัน container แบบ Linux/x64 จึง build ด้วย --platform linux/amd64 เสมอ
#            (บน Mac Apple Silicon จะ build ผ่าน emulation ช้ากว่าปกติ ถือว่าปกติ)
# ==========================================================================
set -euo pipefail

cd "$(dirname "$0")"

TAG="${1:-latest}"
IMAGE_NAME="${IMAGE_NAME:-line-workflow-app}"
IMAGE="${IMAGE_NAME}:${TAG}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
PLATFORM="${PLATFORM:-linux/amd64}"
OUT_ROOT="offline-bundle"
# tag เริ่มต้น (latest) ไม่ต่อท้ายชื่อ bundle
if [ "${TAG}" = "latest" ]; then BUNDLE_NAME="${IMAGE_NAME}"; else BUNDLE_NAME="${IMAGE_NAME}_${TAG}"; fi
OUT_DIR="${OUT_ROOT}/${BUNDLE_NAME}"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "ไม่พบคำสั่ง docker"
docker info >/dev/null 2>&1 || die "Docker ไม่ได้รันอยู่ (เปิด Docker Desktop ก่อน)"
[ -f Dockerfile ] || die "ต้องรันจากโฟลเดอร์ line-workflow-app (ไม่พบ Dockerfile)"

# ---------- 1) build ----------
log "Build ${IMAGE} สำหรับ ${PLATFORM}"
# --provenance/--sbom=false: ไม่แนบ attestation manifest ให้ image เป็น manifest เดี่ยว
# docker load บนเครื่องปลายทาง (โดยเฉพาะ Docker รุ่นเก่า) จะได้ไม่สับสน
BUILD_TAGS=(--tag "${IMAGE}")
[ "${TAG}" != "latest" ] && BUILD_TAGS+=(--tag "${IMAGE_NAME}:latest")
docker buildx build \
  --platform "${PLATFORM}" \
  --provenance=false \
  --sbom=false \
  "${BUILD_TAGS[@]}" \
  --load \
  .

# ---------- 2) pull postgres (ถ้าต้องการ) ----------
IMAGES=("${IMAGE}")
if [ "${SKIP_POSTGRES:-0}" != "1" ]; then
  log "ดึง ${POSTGRES_IMAGE} (${PLATFORM})"
  docker pull --platform "${PLATFORM}" "${POSTGRES_IMAGE}"
  IMAGES+=("${POSTGRES_IMAGE}")
fi

# ---------- 3) save ----------
rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

log "บันทึก image เป็นไฟล์ (docker save)"
# Docker ที่ใช้ containerd image store (Docker Desktop รุ่นใหม่) เก็บ image หลาย platform ไว้ด้วยกัน
# ต้องระบุ --platform ตอน save ไม่งั้นจะ error "unable to create manifests file"
if docker save --help 2>&1 | grep -q -- '--platform'; then
  docker save --platform "${PLATFORM}" "${IMAGES[@]}" | gzip > "${OUT_DIR}/images.tar.gz"
else
  docker save "${IMAGES[@]}" | gzip > "${OUT_DIR}/images.tar.gz"
fi

# ---------- 4) ไฟล์ประกอบสำหรับเครื่องปลายทาง ----------
log "คัดลอกไฟล์ compose / config / สคริปต์ติดตั้ง"
cp docker-compose.prod.yml "${OUT_DIR}/docker-compose.prod.yml"
cp .env.example "${OUT_DIR}/.env.example"
cp deploy/windows/load-and-run.ps1 "${OUT_DIR}/load-and-run.ps1"
cp deploy/windows/load-and-run.bat "${OUT_DIR}/load-and-run.bat"
cp deploy/windows/README-DEPLOY.md "${OUT_DIR}/README-DEPLOY.md"

# บอก compose ว่าให้ใช้ image tag นี้ (ไฟล์ .env ที่ผู้ติดตั้งสร้างจะ override ได้)
cat > "${OUT_DIR}/bundle.env" <<EOF
# สร้างโดย offline-bundle.sh $(date '+%Y-%m-%d %H:%M')
APP_IMAGE=${IMAGE}
POSTGRES_IMAGE=${POSTGRES_IMAGE}
EOF

cat > "${OUT_DIR}/MANIFEST.txt" <<EOF
bundle    : ${BUNDLE_NAME}
built at  : $(date '+%Y-%m-%d %H:%M:%S %Z')
platform  : ${PLATFORM}
git commit: $(git rev-parse --short HEAD 2>/dev/null || echo 'n/a')
images    :
$(printf '  - %s\n' "${IMAGES[@]}")
EOF

# ---------- 5) zip ----------
log "สร้างไฟล์ zip"
(cd "${OUT_ROOT}" && rm -f "${BUNDLE_NAME}.zip" && zip -qr "${BUNDLE_NAME}.zip" "${BUNDLE_NAME}")

log "เสร็จแล้ว"
echo "  โฟลเดอร์ : ${OUT_DIR}"
echo "  ไฟล์ zip : ${OUT_ROOT}/${BUNDLE_NAME}.zip ($(du -h "${OUT_ROOT}/${BUNDLE_NAME}.zip" | cut -f1))"
echo ""
echo "  บนเครื่อง Windows Server:"
echo "    1) แตก zip แล้วเปิด PowerShell ในโฟลเดอร์นั้น (ทับของเดิมได้ ไฟล์ .env เดิมยังใช้ต่อได้)"
echo "    2) ครั้งแรก: copy .env.example .env  แล้วแก้ค่าจริง"
echo "    3) Command Prompt: load-and-run.bat setup            (ถ้ามี PostgreSQL อยู่แล้ว)"
echo "                       load-and-run.bat localdb setup    (ให้ compose เปิด PostgreSQL ให้ด้วย)"
echo "       PowerShell:     .\\load-and-run.ps1 -Setup  /  .\\load-and-run.ps1 -LocalDb -Setup"
