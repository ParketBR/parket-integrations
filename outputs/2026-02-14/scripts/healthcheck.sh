#!/bin/bash
# =============================================
# Parket Control Tower — Healthcheck
# Cron: */5 * * * * /opt/parket/scripts/healthcheck.sh
# =============================================
set -uo pipefail

SLACK_WEBHOOK="${SLACK_WEBHOOK_URL:-}"
API_DOMAIN="${API_DOMAIN:-api.parket.com.br}"
N8N_DOMAIN="${N8N_DOMAIN:-n8n.parket.com.br}"
METABASE_DOMAIN="${METABASE_DOMAIN:-metabase.parket.com.br}"

ERRORS=""

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

check_container() {
    local name="$1"
    if ! docker inspect "${name}" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
        ERRORS="${ERRORS}\n- Container ${name} DOWN"
        log "FALHA: ${name} nao esta rodando"
        return 1
    fi
    log "OK: ${name} rodando"
}

check_url() {
    local name="$1"
    local url="$2"
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${url}" 2>/dev/null)
    if [ "${status}" != "200" ]; then
        ERRORS="${ERRORS}\n- ${name} retornou HTTP ${status}"
        log "FALHA: ${name} HTTP ${status}"
        return 1
    fi
    log "OK: ${name} HTTP 200"
}

check_disk() {
    local usage
    usage=$(df /data | tail -1 | awk '{print $5}' | tr -d '%')
    if [ "${usage}" -gt 85 ]; then
        ERRORS="${ERRORS}\n- Disco /data em ${usage}% (limite: 85%)"
        log "ALERTA: Disco /data em ${usage}%"
        return 1
    fi
    log "OK: Disco /data em ${usage}%"
}

check_postgres() {
    if ! docker exec parket-postgres pg_isready -U parket -q 2>/dev/null; then
        ERRORS="${ERRORS}\n- Postgres nao esta aceitando conexoes"
        log "FALHA: Postgres nao responde"
        return 1
    fi
    log "OK: Postgres aceitando conexoes"
}

check_redis() {
    local pong
    pong=$(docker exec parket-redis redis-cli ping 2>/dev/null)
    if [ "${pong}" != "PONG" ]; then
        ERRORS="${ERRORS}\n- Redis nao responde ao PING"
        log "FALHA: Redis nao responde"
        return 1
    fi
    log "OK: Redis PONG"
}

# ── Executar checks ──
log "=== Healthcheck Parket Tower ==="

check_container "parket-caddy"
check_container "parket-postgres"
check_container "parket-redis"
check_container "parket-n8n"
check_container "parket-metabase"

check_postgres
check_redis

check_url "API Health"    "https://${API_DOMAIN}/health"
check_url "n8n"           "https://${N8N_DOMAIN}/"
check_url "Metabase"      "https://${METABASE_DOMAIN}/api/health"

check_disk

# ── Notificar se houve erros ──
if [ -n "${ERRORS}" ]; then
    log "PROBLEMAS DETECTADOS!"

    if [ -n "${SLACK_WEBHOOK}" ]; then
        curl -s -X POST "${SLACK_WEBHOOK}" \
            -H 'Content-type: application/json' \
            -d "{
                \"text\": \":rotating_light: *Parket Tower Healthcheck FALHOU*\n${ERRORS}\"
            }" > /dev/null 2>&1
        log "Alerta enviado para Slack"
    fi

    exit 1
fi

log "=== Todos os checks OK ==="
