#!/bin/bash
# =============================================
# Parket Control Tower — Backup Postgres to S3
# Cron: 0 3 * * * /opt/parket/scripts/backup.sh
# Usa IAM Role (sem chaves hardcoded)
# =============================================
set -euo pipefail

# ── Config ──
CONTAINER="parket-postgres"
DB_USER="${POSTGRES_USER:-parket}"
DB_NAME="${POSTGRES_DB:-parket_tower}"
S3_BUCKET="${S3_BACKUP_BUCKET:-parket-backups}"
BACKUP_DIR="/data/backups"
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
BACKUP_FILE="parket_tower_${TIMESTAMP}.sql.gz"
RETENTION_DAYS=7  # backups locais

# ── Funcoes ──
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

cleanup_local() {
    log "Limpando backups locais com mais de ${RETENTION_DAYS} dias..."
    find "${BACKUP_DIR}" -name "parket_tower_*.sql.gz" -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true
}

# ── Main ──
log "=== Inicio backup Parket Tower ==="

# Verificar que container esta rodando
if ! docker inspect "${CONTAINER}" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
    log "ERRO: Container ${CONTAINER} nao esta rodando!"
    exit 1
fi

# Criar diretorio se nao existe
mkdir -p "${BACKUP_DIR}"

# Dump todos os databases
log "Fazendo dump de ${DB_NAME}..."
docker exec "${CONTAINER}" pg_dumpall \
    -U "${DB_USER}" \
    --clean \
    --if-exists \
    | gzip > "${BACKUP_DIR}/${BACKUP_FILE}"

FILESIZE=$(du -h "${BACKUP_DIR}/${BACKUP_FILE}" | cut -f1)
log "Backup local criado: ${BACKUP_FILE} (${FILESIZE})"

# Upload para S3
log "Enviando para s3://${S3_BUCKET}/postgres/${BACKUP_FILE}..."
aws s3 cp \
    "${BACKUP_DIR}/${BACKUP_FILE}" \
    "s3://${S3_BUCKET}/postgres/${BACKUP_FILE}" \
    --storage-class STANDARD_IA \
    --only-show-errors

log "Upload S3 concluido"

# Backup dos volumes n8n (workflows exportados)
log "Fazendo backup dos dados n8n..."
N8N_BACKUP="n8n_data_${TIMESTAMP}.tar.gz"
tar -czf "${BACKUP_DIR}/${N8N_BACKUP}" -C /data/n8n . 2>/dev/null || log "WARN: n8n data dir vazio ou inacessivel"

if [ -f "${BACKUP_DIR}/${N8N_BACKUP}" ]; then
    aws s3 cp \
        "${BACKUP_DIR}/${N8N_BACKUP}" \
        "s3://${S3_BUCKET}/n8n/${N8N_BACKUP}" \
        --storage-class STANDARD_IA \
        --only-show-errors
    log "Backup n8n enviado para S3"
fi

# Limpar backups antigos locais
cleanup_local

log "=== Backup concluido com sucesso ==="
