# Parket Control Tower — Runbook Operacional

## Arquitetura

```
┌──────────────────┐   ┌──────────────────┐
│ WhatsApp Partner │   │ Meta/Google/     │
│ Webhook          │   │ Typeform Forms   │
└────────┬─────────┘   └────────┬─────────┘
         │                      │
         ▼                      ▼
┌─────────────────────────────────────────┐
│       Cloud Run — Receiver              │
│                                         │
│  POST /webhook/whatsapp                 │
│  POST /webhook/lead                     │
│  POST /events                           │
│                                         │
│  1. Validar payload (Zod)               │
│  2. Gerar correlation_id               │
│  3. Salvar evento (Postgres)            │
│  4. Chamar Workflow Execution API       │
│  5. Logar tudo (Cloud Logging)          │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│    Google Cloud Workflows               │
│    (Orquestrador Visual)                │
│                                         │
│  Receber → Validar → Rotear:            │
│                                         │
│  lead_created     → upsert lead         │
│  message_received → save conversation   │
│  stage_changed    → update pipeline     │
│  proposal_sent    → register proposal   │
│  won              → mark as won         │
│  obra_created     → create obra         │
│                                         │
│  Todos os passos logam para Cloud       │
│  Logging com correlation_id             │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│       Cloud SQL Postgres                │
│       (Fonte de Verdade)                │
│                                         │
│  events, leads, conversations,          │
│  pipeline, projects, obras              │
└─────────────────────────────────────────┘
```

---

## 1. Deploy

### Pré-requisitos
- Google Cloud CLI (`gcloud`) instalado e autenticado
- Projeto GCP criado com billing ativo
- Docker instalado (para builds locais)

### Deploy completo

```bash
cd outputs/2026-02-14-control-tower
chmod +x infra/setup.sh
./infra/setup.sh SEU_PROJECT_ID southamerica-east1
```

### Deploy apenas do Cloud Run (após alterações de código)

```bash
PROJECT_ID="seu-project-id"
REGION="southamerica-east1"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/parket-images/parket-control-tower:latest"

# Build
gcloud builds submit ./cloudrun-receiver --tag="${IMAGE}" --region="${REGION}"

# Deploy
gcloud run deploy parket-control-tower \
  --image="${IMAGE}" \
  --region="${REGION}"
```

### Deploy apenas do Workflow

```bash
gcloud workflows deploy parket-ingest-event \
  --source=workflows/workflow_ingest_event.yaml \
  --location=southamerica-east1 \
  --call-log-level=log-all-calls
```

### Aplicar schema no banco

```bash
gcloud sql connect parket-control-tower-db \
  --database=parket_control_tower \
  --user=parket-app < sql/001_control_tower_schema.sql
```

---

## 2. Testar Webhook

### Health check

```bash
CLOUD_RUN_URL=$(gcloud run services describe parket-control-tower \
  --region=southamerica-east1 --format="value(status.url)")

curl -s "${CLOUD_RUN_URL}/health" | jq .
```

### Enviar lead de teste

```bash
curl -X POST "${CLOUD_RUN_URL}/webhook/lead" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "manual",
    "name": "João Teste",
    "phone": "11999998888",
    "email": "joao@teste.com",
    "funnel": "end_client",
    "location": "São Paulo",
    "project_type": "residential"
  }' | jq .
```

### Enviar mensagem WhatsApp de teste

```bash
curl -X POST "${CLOUD_RUN_URL}/webhook/whatsapp" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "messages.upsert",
    "data": {
      "key": {
        "remoteJid": "5511999998888@s.whatsapp.net",
        "fromMe": false,
        "id": "TEST123456"
      },
      "pushName": "João Teste",
      "message": {
        "conversation": "Olá, gostaria de saber sobre pisos"
      },
      "messageType": "conversation"
    }
  }' | jq .
```

### Enviar evento genérico

```bash
curl -X POST "${CLOUD_RUN_URL}/events" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "stage_changed",
    "lead_id": "UUID_DO_LEAD",
    "payload": {
      "from_stage": "triagem",
      "to_stage": "qualificado",
      "reason": "Lead respondeu ao primeiro contato"
    }
  }' | jq .
```

---

## 3. Executar Workflow Manualmente

```bash
# Listar workflows
gcloud workflows list --location=southamerica-east1

# Executar workflow diretamente
gcloud workflows run parket-ingest-event \
  --location=southamerica-east1 \
  --data='{
    "event_id": "test-123",
    "correlation_id": "00000000-0000-0000-0000-000000000001",
    "event_type": "lead_created",
    "payload": {
      "name": "Teste Manual",
      "phone": "11999998888",
      "phone_normalized": "5511999998888",
      "source": "manual"
    },
    "source": "manual"
  }'

# Ver execuções recentes
gcloud workflows executions list parket-ingest-event \
  --location=southamerica-east1 \
  --limit=10

# Ver detalhes de uma execução
gcloud workflows executions describe EXECUTION_ID \
  --workflow=parket-ingest-event \
  --location=southamerica-east1
```

---

## 4. Ver Logs

### Cloud Logging — Filtros úteis

#### Todos os logs do Control Tower
```
resource.type="cloud_run_revision"
resource.labels.service_name="parket-control-tower"
```

#### Logs por correlation_id
```
resource.type="cloud_run_revision"
resource.labels.service_name="parket-control-tower"
jsonPayload.correlation_id="SEU_CORRELATION_ID"
```

#### Logs de erro
```
resource.type="cloud_run_revision"
resource.labels.service_name="parket-control-tower"
severity>=ERROR
```

#### Logs do Workflow
```
resource.type="workflows.googleapis.com/Workflow"
resource.labels.workflow_id="parket-ingest-event"
```

#### Workflow execution específico
```
resource.type="workflows.googleapis.com/Workflow"
labels."workflows.googleapis.com/execution_id"="EXECUTION_ID"
```

### Via gcloud CLI

```bash
# Logs do Cloud Run (últimos 30min)
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="parket-control-tower"' \
  --limit=50 \
  --format="table(timestamp, severity, jsonPayload.message)"

# Logs do Workflow (últimos 30min)
gcloud logging read \
  'resource.type="workflows.googleapis.com/Workflow"' \
  --limit=50 \
  --format="table(timestamp, severity, textPayload)"

# Logs por correlation_id
gcloud logging read \
  'jsonPayload.correlation_id="SEU_ID"' \
  --limit=100 \
  --format=json
```

---

## 5. Debugar Falhas

### Fluxo de investigação

1. **Encontrar o correlation_id** — todo webhook retorna o `correlation_id` na resposta
2. **Verificar o evento no banco**:
   ```sql
   SELECT * FROM events WHERE correlation_id = 'SEU_ID' ORDER BY created_at;
   ```
3. **Verificar status do workflow**:
   ```bash
   gcloud workflows executions list parket-ingest-event \
     --location=southamerica-east1 \
     --filter="argument~SEU_CORRELATION_ID" \
     --limit=5
   ```
4. **Ver logs completos**:
   ```bash
   gcloud logging read 'jsonPayload.correlation_id="SEU_ID"' --format=json
   ```

### Problemas comuns

| Sintoma | Causa provável | Solução |
|---------|---------------|---------|
| 400 no webhook | Payload inválido | Verificar schema Zod nos logs |
| 202 na resposta | Evento salvo mas workflow falhou | Verificar SA permissions, quota |
| Workflow FAILED | Erro no handler HTTP | Ver logs do workflow execution |
| Evento duplicado | Idempotência funcionando | Normal — `status: "duplicate"` |
| DB connection error | Cloud SQL não acessível | Verificar Cloud SQL Proxy / SA |

### Re-processar evento falho

```sql
-- Encontrar eventos falhos
SELECT id, correlation_id, event_type, error, created_at
FROM events
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 20;

-- Resetar para reprocessamento
UPDATE events SET status = 'received', error = NULL
WHERE id = 'EVENT_ID';
```

Depois, dispare o workflow manualmente com os dados do evento.

---

## 6. Restaurar Backup

### Cloud SQL — Backups automáticos

```bash
# Listar backups
gcloud sql backups list --instance=parket-control-tower-db

# Restaurar backup (CUIDADO — substitui dados atuais)
gcloud sql backups restore BACKUP_ID \
  --restore-instance=parket-control-tower-db \
  --backup-instance=parket-control-tower-db
```

### Exportar banco para GCS

```bash
# Exportar
gcloud sql export sql parket-control-tower-db \
  gs://SEU_BUCKET/backups/parket-$(date +%Y%m%d).sql \
  --database=parket_control_tower

# Importar
gcloud sql import sql parket-control-tower-db \
  gs://SEU_BUCKET/backups/parket-20260214.sql \
  --database=parket_control_tower
```

### Backup manual via pg_dump

```bash
# Via Cloud SQL Proxy
cloud_sql_proxy -instances=PROJECT:REGION:parket-control-tower-db=tcp:5432 &

pg_dump -h 127.0.0.1 -U parket-app -d parket_control_tower > backup.sql

# Restaurar
psql -h 127.0.0.1 -U parket-app -d parket_control_tower < backup.sql
```

---

## 7. Observabilidade — correlation_id

Cada evento que entra no sistema recebe um `correlation_id` (UUID v4). Este ID permite rastrear **toda a jornada**:

```
Webhook recebido     → correlation_id no log do Cloud Run
  ↓
Evento salvo         → correlation_id na tabela events
  ↓
Workflow iniciado    → correlation_id no argument do workflow
  ↓
Passos executados    → correlation_id em cada log do workflow
  ↓
Banco atualizado     → correlation_id nas tabelas pipeline, conversations, etc.
```

### Consulta de rastreabilidade completa

```sql
-- Timeline completa de um correlation_id
SELECT
  e.event_type,
  e.status,
  e.workflow_execution_id,
  e.created_at,
  l.name AS lead_name,
  l.stage AS lead_stage
FROM events e
LEFT JOIN leads l ON l.id = e.lead_id
WHERE e.correlation_id = 'SEU_CORRELATION_ID'
ORDER BY e.created_at;
```

### Dashboard no Cloud Console

1. Acesse **Workflows** no Console → veja execuções em tempo real
2. Clique em uma execução → veja cada step com input/output
3. Acesse **Cloud Logging** → filtre por `correlation_id`
4. Acesse **Error Reporting** → erros agrupados automaticamente

---

## 8. Secret Manager

### Criar segredo

```bash
echo -n "valor_secreto" | gcloud secrets create NOME_DO_SEGREDO \
  --data-file=- --replication-policy=automatic
```

### Listar segredos

```bash
gcloud secrets list
```

### Acessar segredo

```bash
gcloud secrets versions access latest --secret=NOME_DO_SEGREDO
```

### Segredos usados pelo Control Tower

| Segredo | Descrição |
|---------|-----------|
| `parket-db-password` | Senha do Cloud SQL |
| `parket-whatsapp-secret` | Secret para validação de webhook WhatsApp |

---

## 9. Monitoramento Recomendado

### Alertas a configurar no Cloud Monitoring

1. **Error rate > 5%** no Cloud Run (últimos 5min)
2. **Workflow failure rate > 10%** (últimos 15min)
3. **Cloud SQL CPU > 80%** por mais de 10min
4. **Cloud SQL connections > 80%** do limite
5. **Eventos com status=failed > 10** na última hora

### Query para monitorar saúde

```sql
-- Eventos das últimas 24h por status
SELECT
  status,
  COUNT(*) AS total,
  MIN(created_at) AS oldest,
  MAX(created_at) AS newest
FROM events
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY status;

-- Eventos falhos recentes
SELECT id, correlation_id, event_type, error, created_at
FROM events
WHERE status = 'failed' AND created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;
```
