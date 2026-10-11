#!/usr/bin/env bash
# Local dev servers: ./dev.sh start | stop | status
#   mongo  docker container navevolve-mongo on 27017 (brain/.env MONGODB_URI=mongodb://localhost:27017)
#   brain  uvicorn on $BRAIN_PORT (default 8001; 8000 may be taken)
#   body   vite on $BODY_PORT (default 5000), pointed at the brain
# Logs and pids go to .dev/.
set -euo pipefail
cd "$(dirname "$0")"; ROOT=$PWD
BRAIN_PORT=${BRAIN_PORT:-8001}
BODY_PORT=${BODY_PORT:-5000}
RUN=$ROOT/.dev
mkdir -p "$RUN"

running() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

start() {
  if docker ps -a --format '{{.Names}}' | grep -qx navevolve-mongo; then
    docker start navevolve-mongo >/dev/null
  else
    docker run -d --name navevolve-mongo -p 27017:27017 -v navevolve-mongo:/data/db mongo:7 >/dev/null
  fi
  echo "mongo  up (27017)"

  if running brain; then echo "brain  already running"; else
    (cd brain && nohup .venv/bin/python -m uvicorn server:app --port "$BRAIN_PORT" > "$RUN/brain.log" 2>&1 & echo $! > "$RUN/brain.pid")
    echo "brain  http://localhost:$BRAIN_PORT  (log $RUN/brain.log)"
  fi

  if running body; then echo "body   already running"; else
    (cd body && VITE_BRAIN_URL="http://localhost:$BRAIN_PORT" nohup npx vite --port "$BODY_PORT" --strictPort > "$RUN/body.log" 2>&1 & echo $! > "$RUN/body.pid")
    echo "body   http://localhost:$BODY_PORT  (log $RUN/body.log)"
  fi
}

stop() {
  for s in body brain; do
    if running $s; then
      pid=$(cat "$RUN/$s.pid")
      pkill -P "$pid" 2>/dev/null || true  # npx spawns vite as a child
      kill "$pid" 2>/dev/null || true
      echo "$s stopped"
    fi
    rm -f "$RUN/$s.pid"
  done
  docker stop navevolve-mongo >/dev/null 2>&1 && echo "mongo stopped (data kept)" || true
}

status() {
  for s in brain body; do running $s && echo "$s   running (pid $(cat "$RUN/$s.pid"))" || echo "$s   stopped"; done
  docker ps --filter name=navevolve-mongo --format 'mongo  {{.Status}}' | grep . || echo "mongo  stopped"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "usage: $0 start|stop|restart|status"; exit 1 ;;
esac
