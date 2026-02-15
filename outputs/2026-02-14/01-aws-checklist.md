# AWS Checklist — Parket Integration Control Tower

## 1. Criar EC2

### Instancia Recomendada
- **Tipo:** `t3.medium` (2 vCPU, 4 GB RAM)
  - Suficiente para n8n + Postgres + Redis + Metabase + Caddy
  - Creditos de burst para picos
  - Se crescer, subir para `t3.large` (2 vCPU, 8 GB)
- **AMI:** Ubuntu Server 24.04 LTS (HVM, SSD)
- **Regiao:** `sa-east-1` (Sao Paulo)

### Passo a passo
```
1. AWS Console > EC2 > Launch Instance
2. Nome: parket-control-tower
3. AMI: Ubuntu Server 24.04 LTS
4. Tipo: t3.medium
5. Key pair: criar "parket-key" (RSA, .pem) — baixar e guardar
6. Network: VPC default, subnet publica
7. Auto-assign public IP: Enable
8. Storage: ver passo 2 (EBS)
9. Advanced > User data: deixar vazio (faremos manual)
10. Launch
```

## 2. Anexar EBS (Storage)

- **Root volume:** 30 GB gp3 (SO + Docker)
- **Data volume:** 50 GB gp3 (Postgres + backups locais)

```
1. Na tela de launch, em Storage:
   - Root: 30 GiB, gp3, Delete on termination: Yes
   - Add volume: 50 GiB, gp3, Device: /dev/sdf, Delete on termination: No
2. Apos launch, no servidor:
   sudo mkfs.ext4 /dev/nvme1n1    # ou /dev/xvdf dependendo da instancia
   sudo mkdir /data
   sudo mount /dev/nvme1n1 /data
   echo '/dev/nvme1n1 /data ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
   sudo mkdir -p /data/{postgres,redis,n8n,metabase,backups}
   sudo chown -R 1000:1000 /data
```

## 3. Security Groups

```
Nome: parket-sg

Inbound Rules:
┌──────────┬──────────┬───────────────────────────┬─────────────────────┐
│ Tipo     │ Porta    │ Source                    │ Descricao           │
├──────────┼──────────┼───────────────────────────┼─────────────────────┤
│ SSH      │ 22       │ SEU_IP/32                 │ SSH restrito        │
│ HTTP     │ 80       │ 0.0.0.0/0                │ Caddy HTTP→HTTPS    │
│ HTTPS    │ 443      │ 0.0.0.0/0                │ Caddy HTTPS         │
└──────────┴──────────┴───────────────────────────┴─────────────────────┘

Outbound Rules:
┌──────────┬──────────┬───────────────────────────┐
│ Tipo     │ Porta    │ Destination               │
├──────────┼──────────┼───────────────────────────┤
│ All      │ All      │ 0.0.0.0/0                │
└──────────┴──────────┴───────────────────────────┘

IMPORTANTE:
- NUNCA abrir 5432 (Postgres), 6379 (Redis), 5678 (n8n), 3000 (Metabase)
- Tudo passa pelo Caddy (reverse proxy) na 443
- Atualizar SSH source quando seu IP mudar
```

Para criar via CLI:
```bash
aws ec2 create-security-group \
  --group-name parket-sg \
  --description "Parket Control Tower" \
  --vpc-id <vpc-id>

# SSH restrito
aws ec2 authorize-security-group-ingress \
  --group-name parket-sg \
  --protocol tcp --port 22 \
  --cidr <SEU_IP>/32

# HTTP/HTTPS publico
aws ec2 authorize-security-group-ingress \
  --group-name parket-sg \
  --protocol tcp --port 80 --cidr 0.0.0.0/0

aws ec2 authorize-security-group-ingress \
  --group-name parket-sg \
  --protocol tcp --port 443 --cidr 0.0.0.0/0
```

## 4. Elastic IP

```
1. EC2 > Elastic IPs > Allocate Elastic IP address
2. Actions > Associate Elastic IP address
3. Selecionar a instancia parket-control-tower
4. Associate

IP fixo: anotar para usar no Route53
```

## 5. Route53 DNS

Assumindo dominio `parket.com.br` ja no Route53:

```
Criar Records:

┌─────────────────────────┬──────┬─────────┬───────────────┐
│ Nome                    │ Tipo │ TTL     │ Valor         │
├─────────────────────────┼──────┼─────────┼───────────────┤
│ n8n.parket.com.br       │ A    │ 300     │ <ELASTIC_IP>  │
│ metabase.parket.com.br  │ A    │ 300     │ <ELASTIC_IP>  │
│ api.parket.com.br       │ A    │ 300     │ <ELASTIC_IP>  │
└─────────────────────────┴──────┴─────────┴───────────────┘
```

Via CLI:
```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id <ZONE_ID> \
  --change-batch '{
    "Changes": [
      {
        "Action": "UPSERT",
        "ResourceRecordSet": {
          "Name": "n8n.parket.com.br",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "<ELASTIC_IP>"}]
        }
      },
      {
        "Action": "UPSERT",
        "ResourceRecordSet": {
          "Name": "metabase.parket.com.br",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "<ELASTIC_IP>"}]
        }
      },
      {
        "Action": "UPSERT",
        "ResourceRecordSet": {
          "Name": "api.parket.com.br",
          "Type": "A",
          "TTL": 300,
          "ResourceRecords": [{"Value": "<ELASTIC_IP>"}]
        }
      }
    ]
  }'
```

## 6. IAM Role para Backups S3

```
1. IAM > Roles > Create Role
2. Trusted entity: EC2
3. Permissions: criar policy customizada (ver backup-policy.json)
4. Nome: parket-ec2-backup-role
5. EC2 > Instancia > Actions > Security > Modify IAM role
6. Selecionar parket-ec2-backup-role
```

Policy minima (`parket-backup-policy`):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::parket-backups",
        "arn:aws:s3:::parket-backups/*"
      ]
    }
  ]
}
```

Criar bucket:
```bash
aws s3 mb s3://parket-backups --region sa-east-1
aws s3api put-bucket-lifecycle-configuration \
  --bucket parket-backups \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "cleanup-old-backups",
      "Status": "Enabled",
      "Filter": {"Prefix": "postgres/"},
      "Expiration": {"Days": 30}
    }]
  }'
```
