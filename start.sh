#!/usr/bin/env bash
#
# 启动或重启 OpenPLC Editor Web 服务
#
# 用法:
#   ./start.sh           若未运行则启动；若已运行则询问是否重启
#   ./start.sh --yes|-y  若已运行则直接重启，不询问
#
set -euo pipefail

WEB_SERVICE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$WEB_SERVICE_ROOT"

# shellcheck source=scripts/lib/web-service.sh
source "$WEB_SERVICE_ROOT/scripts/lib/web-service.sh"

FORCE=0

for arg in "$@"; do
  case "$arg" in
    -y | --yes) FORCE=1 ;;
    -h | --help)
      sed -n '3,8p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      ws_err "未知参数: $arg"
      exit 1
      ;;
  esac
done

if service_is_running; then
  if ! prompt_restart_if_running "$FORCE"; then
    exit 0
  fi
  bash "$WEB_SERVICE_ROOT/stop.sh"
  wait_port_free || ws_warn "端口 ${API_PORT} 可能仍被占用，继续尝试启动..."
fi

launch_service
