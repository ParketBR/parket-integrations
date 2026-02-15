# Runbook — Parket Integrations

## 1. Setup Local

```bash
# Clonar repo
git clone <repo-url>
cd parket-integrations

# Instalar dependencias
npm install

# Copiar env
cp .env.example .env
# Preencher .env com valores reais

# Subir infra local
docker compose up -d

# Rodar migrations
npm run migrate

# Iniciar em dev
npm run dev
```

## 2. Deploy (Railway)

```bash
# Login
railway login

# Criar projeto
railway init

# Adicionar Postgres e Redis como add-ons no dashboard Railway

# Configurar env vars no Railway dashboard (copiar de .env)

# Deploy
railway up
```

### Variaveis obrigatorias no Railway:
- `DATABASE_URL` (auto-preenchido pelo add-on Postgres)
- `REDIS_URL` (auto-preenchido pelo add-on Redis)
- `PIPEDRIVE_API_TOKEN`
- `PIPEDRIVE_COMPANY_DOMAIN`
- `META_APP_SECRET`
- `META_VERIFY_TOKEN`
- `META_ACCESS_TOKEN`
- `META_PAGE_ID`
- `GOOGLE_ADS_WEBHOOK_SECRET`
- `WHATSAPP_API_URL`
- `WHATSAPP_API_KEY`
- `WHATSAPP_INSTANCE`
- `SENTRY_DSN`

## 3. Endpoints

| Endpoint | Metodo | Descricao |
|---|---|---|
| `/health` | GET | Healthcheck (Postgres + Redis) |
| `/webhooks/meta` | GET | Meta verification challenge |
| `/webhooks/meta` | POST | Meta Lead Ads webhook |
| `/webhooks/google` | POST | Google Ads lead form |
| `/webhooks/whatsapp` | POST | Evolution API webhook |
| `/webhooks/pipedrive` | POST | Pipedrive deal/activity updates |

## 4. Configuracao de Webhooks

### Meta Lead Ads
1. Ir em Meta Business Suite > Configuracoes do App
2. Webhooks > Adicionar Webhook
3. URL: `https://<domain>/webhooks/meta`
4. Verify Token: valor de `META_VERIFY_TOKEN`
5. Subscribir ao evento `leadgen`

### Google Ads
1. Configurar no Google Ads > Lead Form Extension > Webhook
2. URL: `https://<domain>/webhooks/google?token=<GOOGLE_ADS_WEBHOOK_SECRET>`

### WhatsApp (Evolution API)
1. Na Evolution API, configurar webhook da instancia:
   - URL: `https://<domain>/webhooks/whatsapp`
   - Events: `MESSAGES_UPSERT`

### Pipedrive
1. Ir em Pipedrive > Settings > Webhooks
2. Adicionar webhook:
   - URL: `https://<domain>/webhooks/pipedrive`
   - Events: Deal updated, Activity updated

## 5. Monitoramento

### Healthcheck
```bash
curl https://<domain>/health
# Resposta: {"status":"healthy","services":{"database":"up","redis":"up"}}
```

### Logs
- **Desenvolvimento**: logs coloridos no terminal (pino-pretty)
- **Producao**: logs JSON estruturados no Railway
- **Erros**: Sentry (configurar `SENTRY_DSN`)

### Jobs (BullMQ)
- SLA Check: roda a cada 2 minutos
- Follow-up: roda a cada 4 horas

## 6. Troubleshooting

### Lead nao apareceu no CRM
1. Checar `/health` — infra ok?
2. Checar logs por `webhook:meta` ou `webhook:google`
3. Checar tabela `webhook_logs` por status `failed`
4. Se `duplicate`, lead ja foi processado (dedup)
5. Se `failed`, ver campo `error` para causa raiz

### SLA nao disparou alerta
1. Checar se Redis esta up (`/health`)
2. Checar logs por `job:sla-check`
3. Verificar tabela `sla_events` — campo `breached` e `notified`

### WhatsApp nao enviou mensagem
1. Checar se Evolution API esta acessivel: `curl $WHATSAPP_API_URL/instance/connectionState/$WHATSAPP_INSTANCE`
2. Verificar `WHATSAPP_SDR_GROUP` esta configurado
3. Checar rate limits da Evolution API

### Pipedrive sync falhou
1. Checar `PIPEDRIVE_API_TOKEN` e `PIPEDRIVE_COMPANY_DOMAIN`
2. Verificar rate limits (100 req/2s no plano basico)
3. Ver logs `connector:pipedrive` para detalhes

## 7. Recuperacao

### Reprocessar webhooks falhados
```sql
-- Listar falhos
SELECT * FROM webhook_logs WHERE status = 'failed' ORDER BY created_at DESC;

-- Para reprocessar, mudar status para 'received' e re-enviar payload
UPDATE webhook_logs SET status = 'received' WHERE id = '<uuid>';
```

### Resetar SLAs
```sql
-- Ver SLAs em aberto
SELECT se.*, l.name FROM sla_events se JOIN leads l ON l.id = se.lead_id
WHERE se.completed_at IS NULL ORDER BY se.deadline_at;
```

## 8. Contatos

- **Infra/Deploy**: Douglas
- **CRM (Pipedrive)**: Equipe Comercial
- **WhatsApp API**: Douglas
- **Meta/Google Ads**: Equipe Marketing
