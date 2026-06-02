#!/usr/bin/env bash
#
# OpenPLC Editor Web 版 — Ubuntu 24.04 部署脚本
#
# 用法:
#   ./install.sh 或 bash install.sh   检查依赖 → 构建 → 启动（无需 chmod +x）
#   ./install.sh --check      仅检查依赖
#   ./install.sh --fix-deps   用 apt 安装缺失的系统依赖（需 sudo）
#   ./install.sh --no-start   构建但不启动
#
# 服务管理:
#   ./start.sh                启动；若已运行则询问是否重启
#   ./start.sh --yes          已运行则直接重启
#   ./stop.sh                 停止服务
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

MIN_NODE_MAJOR=20
MAX_NODE_MAJOR=23
MIN_NPM_MAJOR=10

declare -A APT_PACKAGES=(
  [git]="Git 版本管理"
  [curl]="下载 NodeSource / 二进制工具"
  [ca-certificates]="HTTPS 证书"
  [tar]="解压编译工具包"
  [gzip]="解压编译工具包"
  [build-essential]="native 模块编译（serialport 等）"
  [python3]="node-gyp 构建"
  [make]="native 模块编译"
  [g++]="native 模块编译"
  [zenity]="Linux 打开项目目录对话框"
  [libudev-dev]="serialport USB 设备编译依赖"
  [psmisc]="stop.sh 按端口结束进程 (fuser)"
)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}[INFO]${NC} $*"; }
ok() { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err() { echo -e "${RED}[ERR ]${NC} $*" >&2; }

usage() {
  sed -n '3,16p' "$0" | sed 's/^# \?//'
}

arch_to_node() {
  case "$(uname -m)" in
    x86_64) echo "x64" ;;
    aarch64 | arm64) echo "arm64" ;;
    *) echo "$(uname -m)" ;;
  esac
}

check_os() {
  if [[ ! -f /etc/os-release ]]; then
    err "无法读取 /etc/os-release，本脚本面向 Ubuntu 24.04。"
    return 1
  fi
  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    err "当前系统: ${PRETTY_NAME:-unknown}。本脚本仅支持 Ubuntu 24.04。"
    return 1
  fi
  if [[ "${VERSION_ID:-}" != "24.04" ]]; then
    warn "检测到 Ubuntu ${VERSION_ID:-?}，脚本针对 24.04 编写，其他版本可能需手动调整依赖。"
  else
    ok "操作系统: ${PRETTY_NAME}"
  fi
}

check_apt_package() {
  local pkg="$1"
  if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed"; then
    local ver
    ver="$(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || echo "?")"
    ok "系统包 ${pkg} (${ver}) — ${APT_PACKAGES[$pkg]}"
    return 0
  fi
  err "缺少系统包: ${pkg} — ${APT_PACKAGES[$pkg]}"
  return 1
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    err "未安装 Node.js（需要 >= ${MIN_NODE_MAJOR}.x 且 < 24）"
    echo "       建议: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "             sudo apt install -y nodejs"
    return 1
  fi
  local major ver
  major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null)"
  ver="$(node -v 2>/dev/null | sed 's/^v//')"
  if [[ -z "$major" ]] || [[ "$major" -lt "$MIN_NODE_MAJOR" ]] || [[ "$major" -gt "$MAX_NODE_MAJOR" ]]; then
    err "Node.js 版本 ${ver} 不符合要求（需要 >= ${MIN_NODE_MAJOR}.x 且 < 24）"
    return 1
  fi
  ok "Node.js v${ver}"
}

check_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    err "未安装 npm（需要 >= ${MIN_NPM_MAJOR}.x）"
    return 1
  fi
  local major ver
  major="$(npm -v 2>/dev/null | cut -d. -f1)"
  ver="$(npm -v 2>/dev/null)"
  if [[ -z "$major" ]] || [[ "$major" -lt "$MIN_NPM_MAJOR" ]]; then
    err "npm 版本 ${ver} 不符合要求（需要 >= ${MIN_NPM_MAJOR}.x）"
    return 1
  fi
  ok "npm v${ver}"
}

check_repo() {
  if [[ ! -f package.json ]]; then
    err "未找到 package.json，请在仓库根目录运行本脚本。"
    return 1
  fi
  ok "项目目录: $ROOT_DIR"
}

run_dependency_checks() {
  local failed=0
  local missing_apt=()

  echo ""
  info "========== 运行环境检查 (Ubuntu 24.04 Web 部署) =========="
  echo ""

  check_os || failed=1
  check_repo || failed=1
  echo ""

  info "--- 系统依赖 (apt) ---"
  while IFS= read -r pkg; do
    if ! check_apt_package "$pkg"; then
      missing_apt+=("$pkg")
      failed=1
    fi
  done < <(printf '%s\n' "${!APT_PACKAGES[@]}" | sort)

  echo ""
  info "--- Node 运行时 ---"
  check_node || failed=1
  check_npm || failed=1

  echo ""
  if ((${#missing_apt[@]} > 0)); then
    info "可一键安装缺失系统包:"
    echo "  sudo apt update && sudo apt install -y ${missing_apt[*]}"
    echo "  或: ./install.sh --fix-deps"
    echo ""
  fi

  if [[ "$failed" -ne 0 ]]; then
    err "依赖检查未通过，请安装上述缺失项后重新运行 ./install.sh"
    return 1
  fi

  ok "所有必需依赖已满足"
  return 0
}

fix_deps() {
  local missing=()
  for pkg in "${!APT_PACKAGES[@]}"; do
    if ! dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed"; then
      missing+=("$pkg")
    fi
  done
  if ((${#missing[@]} == 0)); then
    ok "系统 apt 依赖已全部安装"
    return 0
  fi
  info "将安装: ${missing[*]}"
  sudo apt update
  sudo apt install -y "${missing[@]}"
}

check_binaries() {
  local node_arch dir
  node_arch="$(arch_to_node)"
  dir="$ROOT_DIR/resources/bin/linux/${node_arch}"

  echo ""
  info "--- 编译工具二进制（npm postinstall 后检查）---"

  if [[ -x "$dir/xml2st" ]] && [[ -x "$dir/iec2c" ]]; then
    ok "xml2st / iec2c 已就绪 ($dir)"
  else
    warn "未找到 xml2st 或 iec2c: $dir"
    warn "请确认 npm install 成功且网络可访问 GitHub Releases"
  fi

  if [[ -x "$dir/arduino-cli" ]]; then
    ok "arduino-cli 已就绪"
  else
    warn "未找到 arduino-cli: $dir/arduino-cli"
    warn "嵌入式板卡编译/上传可能不可用（需手动放入 arduino-cli 二进制）"
  fi
}

check_display_for_zenity() {
  if [[ -z "${DISPLAY:-}" ]] && [[ -z "${WAYLAND_DISPLAY:-}" ]]; then
    warn "未检测到 DISPLAY/WAYLAND（无图形界面）"
    warn "「打开项目」依赖服务端 zenity 对话框，在无桌面环境下会失败"
    warn "无头部署请改用 API 路径打开: project:open-by-path"
  fi
}

deploy() {
  info "========== 构建与部署 =========="
  export HUSKY=0

  info "npm install（含编译工具下载，可能需要数分钟）..."
  npm install

  check_binaries

  info "清理旧前端构建产物..."
  rm -rf "$ROOT_DIR/release/app/dist/renderer"

  info "npm run build:renderer（生成最新前端资源，约 1–3 分钟）..."
  npm run build:renderer

  if [[ ! -f "$ROOT_DIR/release/app/dist/renderer/index.html" ]]; then
    err "前端构建失败: release/app/dist/renderer/index.html 不存在"
    return 1
  fi

  ok "构建完成"
}

main() {
  local mode="full"
  local do_start=1

  for arg in "$@"; do
    case "$arg" in
      --check) mode="check" ;;
      --fix-deps) mode="fix-deps" ;;
      --no-start) do_start=0 ;;
      -h | --help) usage; exit 0 ;;
      *)
        err "未知参数: $arg"
        usage
        exit 1
        ;;
    esac
  done

  case "$mode" in
    check)
      run_dependency_checks
      check_display_for_zenity
      ;;
    fix-deps)
      fix_deps
      run_dependency_checks
      ;;
    full)
      run_dependency_checks || exit 1
      check_display_for_zenity
      deploy || exit 1
      if [[ "$do_start" -eq 1 ]]; then
        info "========== 启动服务 =========="
        exec bash "$ROOT_DIR/start.sh"
      else
        info "已跳过启动（--no-start）"
        info "手动启动: ./start.sh"
      fi
      ;;
  esac
}

main "$@"
