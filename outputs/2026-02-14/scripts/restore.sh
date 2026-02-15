#!/bin/bash
# =============================================
# Parket Control Tower — Restore Postgres from S3
# Uso: ./restore.sh [arquivo_s3]
# Se nao passar argumento, lista backups disponiveis
# =============================================
set -euo pipefail

CONTAINER="parket-postgres"
DB_USER="${POSTGRES_USER:-parket}"
S3_BUCKET="${S3_BACKUP_BUCKET:-parket-backups}"
BACKUP_DIR="/data/backups"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

# ── Sem argumento: listar backups ──
if [ $# -eq 0 ]; then
    echo ""
    echo "Backups disponiveis no S3:"
    echo "─────────────────────────────────────────"
    aws s3 ls "s3://${S3_BUCKET}/postgres/" --human-readable | sort -r | head -20
    echo ""
    echo "Uso: $0 <nome_do_arquivo>"
    echo "  Ex: $0 parket_tower_2026-02-14_030000.sql.gz"
    echo ""
    exit 0
fi

BACKUP_FILE="$1"

# ── Confirmacao ──
echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║  ATENCAO: Restore vai SUBSTITUIR todos    ║"
echo "║  os dados atuais do Postgres!             ║"
echo "╚═══════════════════════════════════════════╝"
echo ""
echo "Arquivo: ${BACKUP_FILE}"
echo ""
read -p "Tem certeza? Digite 'sim' para continuar: " CONFIRM

if [ "${CONFIRM}" != "sim" ]; then
    log "Operacao cancelada."
    exit 0
fi

# ── Download do S3 ──
log "Baixando backup do S3..."
mkdir -p "${BACKUP_DIR}"
aws s3 cp \
    "s3://${S3_BUCKET}/postgres/${BACKUP_FILE}" \
    "${BACKUP_DIR}/${BACKUP_FILE}" \
    --only-show-errors

log "Download concluido"

# ── Parar servicos dependentes ──
log "Parando servicos dependentes..."
cd /opt/parket
docker compose stop n8n metabase 2>/dev/null || docker-compose stop n8n metabase 2>/dev/null || true

# ── Restore ──
log "Iniciando restore..."
gunzip -c "${BACKUP_DIR}/${BACKUP_FILE}" | \
    docker exec -i "${CONTAINER}" psql -U "${DB_USER}" -d postgres 2>&1 | \
    grep -v "^SET$" | grep -v "^$" | head -20

log "Restore concluido"

# ── Reiniciar servicos ──
log "Reiniciando servicos..."
docker compose up -d n8n metabase 2>/dev/null || docker-compose up -d n8n metabase 2>/dev/null

# ── Verificacao ──
log "Verificando databases..."
docker exec "${CONTAINER}" psql -U "${DB_USER}" -d parket_tower -c "SELECT COUNT(*) AS total_leads FROM leads;" 2>/dev/null || true
docker exec "${CONTAINER}" psql -U "${DB_USER}" -d parket_tower -c "SELECT COUNT(*) AS total_events FROM events;" 2>/dev/null || true

log "=== Restore finalizado ==="
echo ""
echo "Proximos passos:"
echo "  1. Verificar se n8n esta funcionando: https://n8n.parket.com.br"
echo "  2. Verificar se Metabase esta funcionando: https://metabase.parket.com.br"
echo "  3. Testar healthcheck: curl https://api.parket.com.br/health"
echo ""
