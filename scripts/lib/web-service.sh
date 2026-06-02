#!/usr/bin/env bash
# 供 start.sh / stop.sh / install.sh source 的公共函数（勿直接执行）

: "${WEB_SERVICE_ROOT:?WEB_SERVICE_ROOT must be set before sourcing}"

ROOT_DIR="$WEB_SERVICE_ROOT"
API_PORT="${API_PORT:-3001}"
PID_FILE="$ROOT_DIR/logs/openplc-web.pid"
LOG_FILE="$ROOT_DIR/logs/openplc-web.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ws_info() { echo -e "${CYAN}[INFO]${NC} $*"; }
ws_ok() { echo -e "${GREEN}[ OK ]${NC} $*"; }
ws_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
ws_err() { echo -e "${RED}[ERR ]${NC} $*" >&2; }

port_is_listening() {
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH "sport = :${API_PORT}" 2>/dev/null | grep -q .
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -i ":${API_PORT}" -sTCP:LISTEN -t >/dev/null 2>&1
    return
  fi
  return 1
}

service_is_running() {
  if port_is_listening; then
    return 0
  fi

  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(tr -d '[:space:]' <"$PID_FILE")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi

  return 1
}

wait_port_free() {
  local i
  for i in {1..20}; do
    if ! service_is_running; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

launch_service() {
  if [[ ! -f "$ROOT_DIR/release/app/dist/renderer/index.html" ]]; then
    ws_err "未找到前端构建产物，请先运行 ./install.sh"
    return 1
  fi

  mkdir -p "$ROOT_DIR/logs"

  export NODE_ENV=production
  export API_PORT
  export HUSKY=0

  ws_info "启动 Web 服务 (NODE_ENV=production, API_PORT=${API_PORT})..."
  nohup npm start >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"

  local i pid
  pid="$(tr -d '[:space:]' <"$PID_FILE")"
  for i in {1..30}; do
    if port_is_listening; then
      print_service_urls
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done

  ws_err "服务启动失败，查看日志: $LOG_FILE"
  tail -n 30 "$LOG_FILE" 2>/dev/null || true
  return 1
  return 0
}

print_service_urls() {
  local ip pid
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")"
  pid="$(tr -d '[:space:]' <"$PID_FILE" 2>/dev/null || echo "?")"

  echo ""
  ws_ok "OpenPLC Editor Web 服务已启动"
  echo "  本地访问:   http://127.0.0.1:${API_PORT}"
  echo "  局域网访问: http://${ip}:${API_PORT}"
  echo "  日志文件:   $LOG_FILE"
  echo "  进程 PID:   ${pid}"
  echo "  停止服务:   ./stop.sh"
  echo ""
}

prompt_restart_if_running() {
  local force="${1:-0}"

  if ! service_is_running; then
    return 0
  fi

  local pid="?"
  [[ -f "$PID_FILE" ]] && pid="$(tr -d '[:space:]' <"$PID_FILE")"

  if [[ "$force" -eq 1 ]]; then
    ws_info "服务已在运行 (PID ${pid})，--yes：将执行重启"
    return 0
  fi

  echo ""
  ws_warn "OpenPLC Web 服务已在运行 (PID ${pid}，端口 ${API_PORT})"
  read -r -p "是否重启服务？[y/N] " answer
  case "$answer" in
    [yY] | [yY][eE][sS])
      return 0
      ;;
    *)
      ws_info "已取消重启，保持当前服务运行"
      print_service_urls
      return 1
      ;;
  esac
}
