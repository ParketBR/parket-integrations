#!/usr/bin/env bash
# ============================================================
# Parket Control Tower — Infrastructure Setup
# Google Cloud Platform
#
# Usage: ./setup.sh <PROJECT_ID> <REGION>
# Example: ./setup.sh parket-prod southamerica-east1
# ============================================================

set -euo pipefail

PROJECT_ID="${1:?Usage: ./setup.sh <PROJECT_ID> <REGION>}"
REGION="${2:-southamerica-east1}"

# Names
SQL_INSTANCE="parket-control-tower-db"
SQL_DB="parket_control_tower"
SQL_USER="parket-app"
SERVICE_NAME="parket-control-tower"
WORKFLOW_NAME="parket-ingest-event"
SA_CLOUDRUN="sa-parket-cloudrun"
SA_WORKFLOW="sa-parket-workflow"

echo "============================================"
echo " Parket Control Tower — GCP Setup"
echo " Project: ${PROJECT_ID}"
echo " Region:  ${REGION}"
echo "============================================"

# ----------------------------------------------------------
# 1. Set project
# ----------------------------------------------------------
echo ">>> Setting project..."
gcloud config set project "${PROJECT_ID}"

# ----------------------------------------------------------
# 2. Enable APIs
# ----------------------------------------------------------
echo ">>> Enabling APIs..."
gcloud services enable \
  workflows.googleapis.com \
  workflowexecutions.googleapis.com \
  run.googleapis.com \
  sqladmin.googleapis.com \
  sql-component.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  logging.googleapis.com \
  cloudresourcemanager.googleapis.com

echo ">>> APIs enabled."

# ----------------------------------------------------------
# 3. Create Service Accounts
# ----------------------------------------------------------
echo ">>> Creating service accounts..."

# Cloud Run service account
gcloud iam service-accounts create "${SA_CLOUDRUN}" \
  --display-name="Parket Control Tower - Cloud Run" \
  --description="Service account for Cloud Run receiver" \
  2>/dev/null || echo "  (SA ${SA_CLOUDRUN} already exists)"

# Workflow service account
gcloud iam service-accounts create "${SA_WORKFLOW}" \
  --display-name="Parket Control Tower - Workflow" \
  --description="Service account for Cloud Workflows" \
  2>/dev/null || echo "  (SA ${SA_WORKFLOW} already exists)"

SA_CLOUDRUN_EMAIL="${SA_CLOUDRUN}@${PROJECT_ID}.iam.gserviceaccount.com"
SA_WORKFLOW_EMAIL="${SA_WORKFLOW}@${PROJECT_ID}.iam.gserviceaccount.com"

# ----------------------------------------------------------
# 4. Grant IAM permissions (minimal)
# ----------------------------------------------------------
echo ">>> Granting IAM permissions..."

# Cloud Run SA: access Secret Manager + Cloud SQL + Logging
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_CLOUDRUN_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" \
  --condition=None --quiet

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_CLOUDRUN_EMAIL}" \
  --role="roles/cloudsql.client" \
  --condition=None --quiet

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_CLOUDRUN_EMAIL}" \
  --role="roles/logging.logWriter" \
  --condition=None --quiet

# Cloud Run SA: can trigger Workflow executions
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_CLOUDRUN_EMAIL}" \
  --role="roles/workflows.invoker" \
  --condition=None --quiet

# Workflow SA: can call Cloud Run
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_WORKFLOW_EMAIL}" \
  --role="roles/run.invoker" \
  --condition=None --quiet

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_WORKFLOW_EMAIL}" \
  --role="roles/logging.logWriter" \
  --condition=None --quiet

echo ">>> IAM permissions granted."

# ----------------------------------------------------------
# 5. Create Cloud SQL Postgres instance
# ----------------------------------------------------------
echo ">>> Creating Cloud SQL instance..."

gcloud sql instances create "${SQL_INSTANCE}" \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region="${REGION}" \
  --storage-type=SSD \
  --storage-size=10GB \
  --storage-auto-increase \
  --backup-start-time="03:00" \
  --enable-bin-log \
  --maintenance-window-day=SUN \
  --maintenance-window-hour=4 \
  --availability-type=zonal \
  --root-password="$(openssl rand -base64 24)" \
  2>/dev/null || echo "  (Instance ${SQL_INSTANCE} already exists)"

echo ">>> Creating database..."
gcloud sql databases create "${SQL_DB}" \
  --instance="${SQL_INSTANCE}" \
  2>/dev/null || echo "  (Database ${SQL_DB} already exists)"

echo ">>> Creating database user..."
DB_PASSWORD="$(openssl rand -base64 24)"
gcloud sql users create "${SQL_USER}" \
  --instance="${SQL_INSTANCE}" \
  --password="${DB_PASSWORD}" \
  2>/dev/null || echo "  (User ${SQL_USER} already exists)"

# Store DB password in Secret Manager
echo ">>> Storing DB password in Secret Manager..."
echo -n "${DB_PASSWORD}" | gcloud secrets create parket-db-password \
  --data-file=- \
  --replication-policy=automatic \
  2>/dev/null || echo "  (Secret parket-db-password already exists)"

CLOUD_SQL_CONNECTION="${PROJECT_ID}:${REGION}:${SQL_INSTANCE}"
echo ">>> Cloud SQL connection name: ${CLOUD_SQL_CONNECTION}"

# ----------------------------------------------------------
# 6. Apply database schema
# ----------------------------------------------------------
echo ">>> Applying database schema..."
echo "   Run the following command to apply the schema:"
echo ""
echo "   gcloud sql connect ${SQL_INSTANCE} --database=${SQL_DB} --user=${SQL_USER} < sql/001_control_tower_schema.sql"
echo ""

# ----------------------------------------------------------
# 7. Create Artifact Registry (for Docker images)
# ----------------------------------------------------------
echo ">>> Creating Artifact Registry..."
gcloud artifacts repositories create parket-images \
  --repository-format=docker \
  --location="${REGION}" \
  --description="Parket Control Tower Docker images" \
  2>/dev/null || echo "  (Repository parket-images already exists)"

# ----------------------------------------------------------
# 8. Build & Deploy Cloud Run
# ----------------------------------------------------------
echo ">>> Building Docker image..."
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/parket-images/${SERVICE_NAME}:latest"

gcloud builds submit ./cloudrun-receiver \
  --tag="${IMAGE_URI}" \
  --region="${REGION}"

echo ">>> Deploying Cloud Run service..."
gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE_URI}" \
  --region="${REGION}" \
  --platform=managed \
  --service-account="${SA_CLOUDRUN_EMAIL}" \
  --add-cloudsql-instances="${CLOUD_SQL_CONNECTION}" \
  --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},GCP_REGION=${REGION},WORKFLOW_NAME=${WORKFLOW_NAME},DB_NAME=${SQL_DB},DB_USER=${SQL_USER},CLOUD_SQL_CONNECTION_NAME=${CLOUD_SQL_CONNECTION}" \
  --set-secrets="DB_PASS=parket-db-password:latest" \
  --port=8080 \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=10 \
  --timeout=60 \
  --allow-unauthenticated \
  --ingress=all

CLOUD_RUN_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region="${REGION}" --format="value(status.url)")

echo ">>> Cloud Run deployed at: ${CLOUD_RUN_URL}"

# ----------------------------------------------------------
# 9. Deploy Workflow
# ----------------------------------------------------------
echo ">>> Deploying workflow..."
gcloud workflows deploy "${WORKFLOW_NAME}" \
  --source=workflows/workflow_ingest_event.yaml \
  --location="${REGION}" \
  --service-account="${SA_WORKFLOW_EMAIL}" \
  --call-log-level=log-all-calls \
  --description="Parket Control Tower — Event ingestion and routing"

echo ">>> Workflow deployed."

# ----------------------------------------------------------
# 10. Summary
# ----------------------------------------------------------
echo ""
echo "============================================"
echo " SETUP COMPLETE"
echo "============================================"
echo ""
echo " Cloud Run URL:     ${CLOUD_RUN_URL}"
echo " Cloud SQL:         ${CLOUD_SQL_CONNECTION}"
echo " Workflow:          ${WORKFLOW_NAME}"
echo " SA Cloud Run:      ${SA_CLOUDRUN_EMAIL}"
echo " SA Workflow:       ${SA_WORKFLOW_EMAIL}"
echo ""
echo " Endpoints:"
echo "   POST ${CLOUD_RUN_URL}/webhook/whatsapp"
echo "   POST ${CLOUD_RUN_URL}/webhook/lead"
echo "   POST ${CLOUD_RUN_URL}/events"
echo "   GET  ${CLOUD_RUN_URL}/health"
echo ""
echo " Next steps:"
echo "   1. Apply schema: gcloud sql connect ${SQL_INSTANCE} --database=${SQL_DB} --user=${SQL_USER}"
echo "   2. Test health:  curl ${CLOUD_RUN_URL}/health"
echo "   3. Configure webhook URLs in WhatsApp partner / Meta / Google"
echo "============================================"
