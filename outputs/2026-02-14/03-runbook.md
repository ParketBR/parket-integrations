# Runbook de Operacao — Parket Control Tower

## Acesso

```bash
ssh parket@<ELASTIC_IP>
cd /opt/parket
```

## Comandos Essenciais

### Status dos servicos
```bash
docker compose ps
docker compose logs --tail 50 -f          # todos
docker compose logs --tail 50 -f n8n      # so n8n
docker compose logs --tail 50 -f caddy    # so caddy
```

### Restart de servicos
```bash
docker compose restart n8n        # restart n8n sem derrubar banco
docker compose restart metabase   # restart metabase
docker compose down && docker compose up -d  # restart completo
```

### Atualizar imagens
```bash
docker compose pull
docker compose up -d --remove-orphans
```

---

## Healthcheck

### Manual
```bash
# API
curl https://api.parket.com.br/health

# Postgres
docker exec parket-postgres pg_isready -U parket

# Redis
docker exec parket-redis redis-cli ping

# n8n
curl -s -o /dev/null -w "%{http_code}" https://n8n.parket.com.br/

# Metabase
curl -s https://metabase.parket.com.br/api/health
```

### Automatizado (cron)
```bash
# Adicionar ao crontab do usuario parket:
crontab -e

# Healthcheck a cada 5 min
*/5 * * * * /opt/parket/scripts/healthcheck.sh >> /data/backups/healthcheck.log 2>&1

# Backup diario as 3h
0 3 * * * /opt/parket/scripts/backup.sh >> /data/backups/backup.log 2>&1
```

---

## Debug de Problemas

### Lead nao chegou

1. Verificar se o webhook foi recebido:
```sql
-- Conectar ao banco
docker exec -it parket-postgres psql -U parket -d parket_tower

-- Ultimos eventos
SELECT id, event_type, source, status, idempotency_key, created_at
FROM events
ORDER BY created_at DESC
LIMIT 20;
```

2. Se o evento existe mas status = 'failed':
```sql
SELECT id, error_message, payload
FROM events
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 10;
```

3. Se o evento nao existe, verificar logs do Caddy:
```bash
docker compose logs --tail 100 caddy | grep "webhooks"
```

4. Verificar se n8n recebeu:
```bash
docker compose logs --tail 100 n8n | grep "webhook"
```

### Lead duplicado

Leads sao deduplicados por `phone_normalized`. Se precisar reprocessar:

```sql
-- Ver se o lead existe
SELECT id, name, phone_normalized, source, status, created_at
FROM leads
WHERE phone_normalized = '5511999999999';

-- Se precisar permitir reprocessamento, deletar o registro antigo
-- CUIDADO: isso perde historico
DELETE FROM leads WHERE phone_normalized = '5511999999999';

-- Ou apenas atualizar o status
UPDATE leads SET status = 'new', updated_at = NOW()
WHERE phone_normalized = '5511999999999';
```

### Evento duplicado

Eventos usam `idempotency_key` para prevenir duplicatas. Se um webhook foi recebido mas nao processado:

```sql
-- Verificar status do evento
SELECT * FROM events WHERE idempotency_key = 'meta_123456789';

-- Resetar para reprocessamento
UPDATE events
SET status = 'received', error_message = NULL, processed_at = NULL
WHERE idempotency_key = 'meta_123456789';
```

Depois, re-disparar o webhook via n8n (Menu > Executions > selecionar > Retry).

### WhatsApp nao envia

1. Verificar credenciais:
```bash
# Testar conectividade com a API
curl -s -X GET "${WHATSAPP_API_URL}/status/${WHATSAPP_INSTANCE}" \
  -H "Authorization: Bearer ${WHATSAPP_API_KEY}"
```

2. Verificar logs de conversas:
```sql
SELECT id, lead_id, direction, status, content, created_at
FROM conversations
WHERE phone = '5511999999999'
ORDER BY created_at DESC
LIMIT 20;
```

3. Verificar se instancia esta conectada no painel Z-API / Evolution API.

### SLA breach nao notificado

```sql
-- SLAs em breach nao notificados
SELECT s.*, l.name, l.phone
FROM sla_events s
JOIN leads l ON l.id = s.lead_id
WHERE s.breached = TRUE AND s.notified = FALSE;

-- Marcar como notificado apos resolver manualmente
UPDATE sla_events SET notified = TRUE WHERE id = <ID>;
```

### Metabase lento

```sql
-- Verificar tamanho das tabelas
SELECT
    relname AS table,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
    n_live_tup AS row_count
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC;

-- Rodar VACUUM se necessario
VACUUM ANALYZE leads;
VACUUM ANALYZE events;
VACUUM ANALYZE conversations;
```

### Disco cheio

```bash
# Verificar uso
df -h /data

# Limpar execucoes antigas do n8n (via UI ou banco)
docker exec parket-postgres psql -U parket -d parket_n8n \
  -c "DELETE FROM execution_entity WHERE \"stoppedAt\" < NOW() - INTERVAL '7 days';"

# Limpar logs Docker
docker system prune -f

# Limpar backups antigos locais
find /data/backups -name "*.sql.gz" -mtime +7 -delete
```

---

## Backup & Restore

### Backup manual
```bash
/opt/parket/scripts/backup.sh
```

### Listar backups no S3
```bash
/opt/parket/scripts/restore.sh
# (sem argumentos lista os backups)
```

### Restore
```bash
/opt/parket/scripts/restore.sh parket_tower_2026-02-14_030000.sql.gz
```

### Verificar ultimo backup
```bash
aws s3 ls s3://parket-backups/postgres/ --human-readable | sort -r | head -5
```

---

## Monitoramento

### Metricas do sistema
```bash
htop                              # CPU e memoria
docker stats                      # recursos por container
df -h /data                       # disco
```

### Logs estruturados
```bash
# n8n com filtro
docker compose logs n8n --since 1h | grep -i error

# Caddy acessos
docker compose logs caddy --since 1h | grep "POST /webhooks"

# Erros do Postgres
docker compose logs postgres --since 1h | grep -i "error\|fatal"
```

### Queries uteis para dashboard
```sql
-- Leads hoje
SELECT COUNT(*) FROM leads WHERE created_at >= CURRENT_DATE;

-- Eventos por status
SELECT status, COUNT(*) FROM events GROUP BY status;

-- Mensagens WhatsApp hoje
SELECT direction, COUNT(*)
FROM conversations
WHERE created_at >= CURRENT_DATE
GROUP BY direction;

-- SLA compliance
SELECT * FROM v_sla_compliance;

-- Pipeline overview
SELECT * FROM v_pipeline_overview;
```

---

## Procedimentos de Emergencia

### n8n nao responde
```bash
docker compose restart n8n
# Se persistir:
docker compose logs n8n --tail 200
# Se OOM (Out of Memory):
# Aumentar limite em docker-compose.yml (deploy.resources.limits.memory)
```

### Postgres nao inicia
```bash
docker compose logs postgres --tail 50
# Se corrompido:
docker compose stop
# Restore do ultimo backup:
/opt/parket/scripts/restore.sh <ultimo_backup>
```

### Caddy certificado SSL expirado
```bash
# Caddy renova automaticamente. Se falhou:
docker compose restart caddy
docker compose logs caddy | grep -i "certificate\|tls\|acme"
# Verificar que porta 80 esta aberta (necessaria para ACME challenge)
```

### Migrar para instancia maior
```bash
# 1. Fazer backup
/opt/parket/scripts/backup.sh

# 2. Na nova instancia, rodar setup
sudo bash 02-server-setup.sh

# 3. Copiar configs
scp -r /opt/parket/* parket@<NOVA_IP>:/opt/parket/

# 4. Restore
# Na nova instancia:
cd /opt/parket
docker compose up -d postgres redis
# Esperar postgres ficar healthy, depois:
/opt/parket/scripts/restore.sh <ultimo_backup>
docker compose up -d

# 5. Atualizar Elastic IP para nova instancia
# 6. Testar tudo
```

---

## Contatos

| Servico | Dashboard | Documentacao |
|---------|-----------|-------------|
| n8n | https://n8n.parket.com.br | https://docs.n8n.io |
| Metabase | https://metabase.parket.com.br | https://www.metabase.com/docs |
| Z-API | Painel Z-API | https://developer.z-api.io |
| Pipedrive | parket.pipedrive.com | https://developers.pipedrive.com |
| AWS | Console AWS | - |
