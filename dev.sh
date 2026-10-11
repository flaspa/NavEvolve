#!/usr/bin/env bash
# Local dev servers: ./dev.sh start | stop | restart | status | wipe [scene_id] [--yes]
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

wipe() {  # ./dev.sh wipe [scene_id] [--yes] — forget observations, objects, episodes, place graphs (local DB only)
  (cd brain && .venv/bin/python - "${1:-}" "${2:-}" <<'EOF'
import sys
from dotenv import dotenv_values
import pymongo
env = dotenv_values(".env")
args = [a for a in sys.argv[1:] if a]
yes = "--yes" in args
scene = next((a for a in args if a != "--yes"), None)
uri = env.get("MONGODB_URI", "")
if not uri.startswith(("mongodb://localhost", "mongodb://127.0.0.1")):
    sys.exit("refusing: MONGODB_URI is not a local database")
db = pymongo.MongoClient(uri)[env["MONGODB_DB"]]
q = {"scene_id": scene} if scene else {}
counts = {c: db[c].count_documents(q) for c in ("observations", "objects", "episodes", "cognitive_graphs")}
print("will delete", counts, "for", scene or "ALL scenes")
ok = yes
try:  # stdin is this script, so ask the terminal
    if not ok:
      with open("/dev/tty") as tty:
        print("type yes to confirm (or pass --yes): ", end="", flush=True); ok = tty.readline().strip() == "yes"
except OSError:
    ok = False
if not ok:
    sys.exit("cancelled")
for c in counts:
    db[c].delete_many(q)
print("done (harness policies kept)")
EOF
  )
}

case "${1:-}" in
  wipe) wipe "${2:-}" "${3:-}" ;;
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "usage: $0 start|stop|restart|status|wipe [scene_id] [--yes]"; exit 1 ;;
esac
