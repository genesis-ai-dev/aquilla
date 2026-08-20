#!/usr/bin/env bash
# Install a dedicated Hetzner CI box for Aquilla e2e (and later unit lanes).
#
# Safe to pipe over SSH from your laptop — this file does not need to live on
# the server first:
#
#   ssh root@HETZNER 'bash -s' < scripts/hetzner-ci/bootstrap.sh
#   ssh root@HETZNER 'bash -s -- --runtime=colima' < scripts/hetzner-ci/bootstrap.sh
#
# Default runtime is Docker Engine. On Linux that is the light path: Colima
# (Lima + QEMU) adds a nested VM and needs nested virtualization. Colima is
# what we use on Macs instead of Docker Desktop; pass --runtime=colima only
# if you deliberately want that stack on the server.
set -euo pipefail

RUNTIME=docker
CI_USER=ci

usage() {
  cat <<'EOF'
Usage: bootstrap.sh [--runtime=docker|colima] [--user=ci]

  --runtime=docker   Docker Engine (default; lightest on Linux)
  --runtime=colima   Colima + Lima + QEMU (Mac-shaped; heavier on Linux)
  --user=NAME        Unprivileged account that owns runners and docker (default: ci)
EOF
}

for arg in "$@"; do
  case "$arg" in
    --runtime=docker|--runtime=colima) RUNTIME="${arg#--runtime=}" ;;
    --user=*) CI_USER="${arg#--user=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "bootstrap.sh must run as root (sudo or ssh root@host)." >&2
  exit 1
fi

if [ ! -f /etc/os-release ] || ! grep -q '^ID=ubuntu' /etc/os-release; then
  echo "bootstrap.sh targets Ubuntu (Hetzner default). Refusing other distros." >&2
  exit 1
fi

log() { printf '[hetzner-ci] %s\n' "$*"; }

export DEBIAN_FRONTEND=noninteractive
. /etc/os-release

log "installing base packages"
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl git gnupg jq lsb-release \
  python3 python3-pip fonts-liberation fonts-noto-color-emoji

if ! id -u "$CI_USER" >/dev/null 2>&1; then
  log "creating user $CI_USER"
  useradd --create-home --shell /bin/bash "$CI_USER"
fi

install_docker_engine() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    log "docker engine already running"
    return
  fi
  log "installing Docker Engine"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  systemctl enable --now docker
}

install_colima() {
  log "checking nested virtualization for Colima/Lima/QEMU"
  if ! grep -Eq 'vmx|svm' /proc/cpuinfo; then
    echo "CPU does not advertise VMX/SVM. Colima cannot run here. Use --runtime=docker." >&2
    exit 1
  fi
  if [ -f /sys/module/kvm_intel/parameters/nested ] && [ "$(cat /sys/module/kvm_intel/parameters/nested)" = "N" ]; then
    echo "Intel nested virtualization is disabled. Use --runtime=docker or enable nested virt." >&2
    exit 1
  fi
  if [ -f /sys/module/kvm_amd/parameters/nested ] && [ "$(cat /sys/module/kvm_amd/parameters/nested)" = "0" ]; then
    echo "AMD nested virtualization is disabled. Use --runtime=docker or enable nested virt." >&2
    exit 1
  fi

  apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils
  install_docker_engine

  local lima_ver colima_ver arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64) arch=x86_64 ;;
    aarch64) arch=aarch64 ;;
    *) echo "unsupported arch $arch for Colima" >&2; exit 1 ;;
  esac

  lima_ver="$(curl -fsSL https://api.github.com/repos/lima-vm/lima/releases/latest | jq -r .tag_name)"
  colima_ver="$(curl -fsSL https://api.github.com/repos/abiosoft/colima/releases/latest | jq -r .tag_name)"
  log "installing lima $lima_ver and colima $colima_ver"
  curl -fsSL "https://github.com/lima-vm/lima/releases/download/${lima_ver}/lima-${lima_ver#v}-Linux-${arch}.tar.gz" \
    | tar -xz -C /usr/local
  curl -fsSL "https://github.com/abiosoft/colima/releases/download/${colima_ver}/colima-Linux-${arch}" \
    -o /usr/local/bin/colima
  chmod +x /usr/local/bin/colima

  log "starting Colima as $CI_USER (docker runtime inside the VM)"
  sudo -u "$CI_USER" -H colima start --cpu 2 --memory 6 --disk 40 --runtime docker || {
    echo "colima start failed. On Hetzner this is usually missing nested virt — use --runtime=docker." >&2
    exit 1
  }
}

case "$RUNTIME" in
  docker) install_docker_engine ;;
  colima) install_colima ;;
esac

usermod -aG docker "$CI_USER"

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22)'; then
  log "installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

log "enabling pnpm via corepack (packageManager pnpm@10.19.0)"
corepack enable
corepack prepare pnpm@10.19.0 --activate

log "installing Playwright OS libraries (chromium)"
npx --yes playwright install-deps chromium

log "done. runtime=$RUNTIME user=$CI_USER"
log "next: ssh as root and run ensure-e2e-runtime.sh, then install-runners.sh"
log "recommended size: 4 vCPU / 16 GB (smoke runs 3 isolated stacks)"
