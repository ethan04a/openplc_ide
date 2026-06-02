#!/usr/bin/env bash
#
# 停止 OpenPLC Editor Web 服务
#
set -euo pipefail

WEB_SERVICE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$WEB_SERVICE_ROOT"
# shellcheck source=scripts/lib/web-service.sh
source "$WEB_SERVICE_ROOT/scripts/lib/web-service.sh"

stop_by_pid() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi

  local pid
  pid="$(tr -d '[:space:]' <"$PID_FILE")"
  [[ -z "$pid" ]] && return 1

  if kill -0 "$pid" 2>/dev/null; then
    ws_info "停止 OpenPLC Web 服务 (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    ws_ok "已结束进程 $pid"
    return 0
  fi

  return 1
}

stop_by_port() {
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${API_PORT}/tcp" >/dev/null 2>&1 || true
    sleep 1
    return 0
  fi

  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -ti ":${API_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
      sleep 1
    fi
  fi
}

if ! service_is_running; then
  ws_warn "服务未在运行（端口 ${API_PORT}）"
  rm -f "$PID_FILE"
  exit 0
fi

stop_by_pid || ws_warn "PID 文件无效或进程已退出，尝试按端口 ${API_PORT} 结束..."
stop_by_port
rm -f "$PID_FILE"

if service_is_running; then
  ws_err "未能完全停止服务，请手动检查端口 ${API_PORT}"
  exit 1
fi

ws_ok "服务已停止"
exit 0
