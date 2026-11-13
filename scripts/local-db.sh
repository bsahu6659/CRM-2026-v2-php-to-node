#!/bin/sh
# ---------------------------------------------------------------------------
# Local development MySQL, kept entirely inside this project's .dev/ folder.
#
#   sh scripts/local-db.sh start    start it (no-op if already running)
#   sh scripts/local-db.sh stop     stop it cleanly
#   sh scripts/local-db.sh status   say whether it is running
#
# Homebrew no longer ships prebuilt MySQL/MariaDB for Intel Macs, so the
# official MySQL 8.4 LTS binary lives in .dev/mysql and its data in
# .dev/mysql-data. Nothing is installed system-wide and nothing starts at
# login: `npm run dev:server` calls `start` first, and `npm run db:stop`
# shuts it down.
#
# Without .dev/mysql (a teammate using their own MySQL) this script does
# nothing, and the API connects wherever server/.env's DB_HOST points.
# ---------------------------------------------------------------------------

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="$ROOT/.dev"
BASE="$DEV/mysql"
CNF="$DEV/my.cnf"
PIDFILE="$DEV/mysql.pid"
LOG="$DEV/mysql.err"

running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

if [ ! -x "$BASE/bin/mysqld" ]; then
  echo "[db] no local MySQL in .dev/ - using the database configured in server/.env"
  exit 0
fi

case "${1:-status}" in
  start)
    if running; then
      echo "[db] local MySQL already running (pid $(cat "$PIDFILE"))"
      exit 0
    fi
    "$BASE/bin/mysqld" --defaults-file="$CNF" --daemonize >/dev/null 2>&1 || {
      echo "[db] MySQL failed to start - last lines of $LOG:"
      tail -n 20 "$LOG"
      exit 1
    }
    # --daemonize returns once the server accepts connections, but give a
    # slow disk a moment before the API's first query.
    i=0
    until "$BASE/bin/mysqladmin" --defaults-file="$CNF" -uroot ping >/dev/null 2>&1; do
      i=$((i + 1))
      if [ "$i" -ge 30 ]; then
        echo "[db] MySQL did not answer within 30s - see $LOG"
        exit 1
      fi
      sleep 1
    done
    echo "[db] local MySQL running on 127.0.0.1:3306 (pid $(cat "$PIDFILE"))"
    ;;
  stop)
    if ! running; then
      echo "[db] local MySQL is not running"
      exit 0
    fi
    # SIGTERM is MySQL's clean shutdown: it flushes and closes every table.
    kill "$(cat "$PIDFILE")"
    i=0
    while running; do
      i=$((i + 1))
      if [ "$i" -ge 60 ]; then
        echo "[db] MySQL is still shutting down - check $LOG"
        exit 1
      fi
      sleep 1
    done
    echo "[db] local MySQL stopped"
    ;;
  status)
    if running; then
      echo "[db] local MySQL running (pid $(cat "$PIDFILE"))"
    else
      echo "[db] local MySQL is not running - start it with: npm run db:start"
    fi
    ;;
  *)
    echo "usage: sh scripts/local-db.sh start|stop|status"
    exit 2
    ;;
esac
