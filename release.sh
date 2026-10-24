#!/bin/sh
# Safe release for the AI gateway: install -> typecheck -> tests -> restart -> health gate,
# with an automatic rollback to the previous release if the health gate fails.
#
#   sh release.sh                 # docker compose (default)
#   DEPLOY_MODE=pm2 sh release.sh # pm2 on the host (uses pm2.config.json)
#
# Run it from the checked-out version you want to release. Exit code 0 = live and healthy,
# 1 = failed (rolled back where possible).
set -eu

cd "$(dirname "$0")"

MODE="${DEPLOY_MODE:-docker}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8081/health}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-30}"
STATE_DIR=".release"
mkdir -p "$STATE_DIR"

log() { printf '[release] %s\n' "$*"; }
fail() { printf '[release] FAILED: %s\n' "$*" >&2; }

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- -T 3 "$1"
  else
    fail "neither curl nor wget is available for the health gate"
    return 1
  fi
}

# Healthy means: answers, status ok, and an API key is configured (a gateway without a key
# is up but refuses every request, which is not a successful release).
wait_healthy() {
  waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    body="$(fetch "$HEALTH_URL" 2>/dev/null || true)"
    case "$body" in
      *'"status":"ok"'*'"authConfigured":true'*) return 0 ;;
      *'"authConfigured":false'*) fail "gateway is up but AI_PROCESSOR_API_KEY is not set"; return 1 ;;
    esac
    waited=$((waited + 1))
    sleep 1
  done
  return 1
}

# ---- 1. install, typecheck, test (the gate before anything is touched) -------------------
log "installing dependencies"
npm ci

log "typechecking"
npm run typecheck

log "running tests"
npm test

# ---- 2. release --------------------------------------------------------------------------
case "$MODE" in
  docker)
    if docker image inspect ai-processor:current >/dev/null 2>&1; then
      log "keeping the running image as ai-processor:previous"
      docker tag ai-processor:current ai-processor:previous
    fi

    log "building and starting"
    docker compose build
    docker compose up -d

    if wait_healthy; then
      log "healthy: release complete"
      exit 0
    fi

    fail "health gate failed"
    docker compose logs --tail=40 ai-processor >&2 || true
    if docker image inspect ai-processor:previous >/dev/null 2>&1; then
      log "rolling back to ai-processor:previous"
      docker tag ai-processor:previous ai-processor:current
      docker compose up -d --no-build
      if wait_healthy; then
        log "rollback is healthy"
      else
        fail "rollback is NOT healthy either: check the host now"
      fi
    else
      fail "no previous image to roll back to"
    fi
    exit 1
    ;;

  pm2)
    command -v pm2 >/dev/null 2>&1 || { fail "pm2 is not installed"; exit 1; }

    log "installing production dependencies only"
    npm ci --omit=dev

    PREVIOUS=""
    [ -f "$STATE_DIR/last_good" ] && PREVIOUS="$(cat "$STATE_DIR/last_good")"

    log "restarting under pm2"
    pm2 startOrReload pm2.config.json --update-env

    if wait_healthy; then
      git rev-parse HEAD > "$STATE_DIR/last_good" 2>/dev/null || true
      log "healthy: release complete"
      exit 0
    fi

    fail "health gate failed"
    pm2 logs ai-processor --lines 40 --nostream >&2 || true
    if [ -n "$PREVIOUS" ] && git cat-file -e "$PREVIOUS" 2>/dev/null; then
      log "rolling back to $PREVIOUS"
      git checkout -q "$PREVIOUS"
      npm ci --omit=dev
      pm2 startOrReload pm2.config.json --update-env
      if wait_healthy; then
        log "rollback is healthy (checkout is now detached at $PREVIOUS)"
      else
        fail "rollback is NOT healthy either: check the host now"
      fi
    else
      fail "no previous release recorded to roll back to"
    fi
    exit 1
    ;;

  *)
    fail "DEPLOY_MODE must be docker or pm2 (got: $MODE)"
    exit 1
    ;;
esac
