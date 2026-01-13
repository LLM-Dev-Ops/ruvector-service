#!/bin/bash
# Deploy ruvvector-service to Google Cloud Run
# Usage: ./scripts/deploy-cloudrun.sh

set -e

# Configuration
PROJECT_ID="agentics-dev"
REGION="us-central1"
SERVICE_NAME="ruvvector-service"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# Database configuration
DB_HOST="34.171.232.21"
DB_PORT="5432"
DB_NAME="ruvector-postgres"
DB_USER="postgres"
DB_PASSWORD="7yekrYmmMj74Te26!"

echo "==> Deploying ${SERVICE_NAME} to Cloud Run"
echo "    Project: ${PROJECT_ID}"
echo "    Region: ${REGION}"

# Check if gcloud is authenticated
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q .; then
    echo "ERROR: Not authenticated with gcloud. Run: gcloud auth login"
    exit 1
fi

# Set project
gcloud config set project ${PROJECT_ID}

# Enable required APIs
echo "==> Enabling required APIs..."
gcloud services enable cloudbuild.googleapis.com run.googleapis.com containerregistry.googleapis.com --quiet

# Build and push container image
echo "==> Building container image..."
gcloud builds submit --tag ${IMAGE_NAME} .

# Deploy to Cloud Run
echo "==> Deploying to Cloud Run..."
gcloud run deploy ${SERVICE_NAME} \
    --image ${IMAGE_NAME} \
    --region ${REGION} \
    --platform managed \
    --allow-unauthenticated \
    --port 8080 \
    --memory 512Mi \
    --cpu 1 \
    --min-instances 0 \
    --max-instances 10 \
    --timeout 60 \
    --set-env-vars "PORT=8080" \
    --set-env-vars "LOG_LEVEL=info" \
    --set-env-vars "RUVECTOR_SERVICE_URL=http://localhost:6379" \
    --set-env-vars "RUVECTOR_DB_HOST=${DB_HOST}" \
    --set-env-vars "RUVECTOR_DB_PORT=${DB_PORT}" \
    --set-env-vars "RUVECTOR_DB_NAME=${DB_NAME}" \
    --set-env-vars "RUVECTOR_DB_USER=${DB_USER}" \
    --set-env-vars "RUVECTOR_DB_PASSWORD=${DB_PASSWORD}" \
    --set-env-vars "RUVECTOR_DB_MAX_CONNECTIONS=20" \
    --set-env-vars "RUVECTOR_DB_SSL=false"

# Get service URL
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} --region ${REGION} --format='value(status.url)')

echo ""
echo "==> Deployment complete!"
echo "    Service URL: ${SERVICE_URL}"
echo ""
echo "==> Testing health endpoint..."
curl -s "${SERVICE_URL}/health" | python3 -m json.tool || echo "Health check output above"

echo ""
echo "==> API Endpoints:"
echo "    POST   ${SERVICE_URL}/v1/plans      - Store a plan"
echo "    GET    ${SERVICE_URL}/v1/plans/:id  - Retrieve a plan"
echo "    GET    ${SERVICE_URL}/v1/plans      - List plans"
echo "    DELETE ${SERVICE_URL}/v1/plans/:id  - Delete a plan"
echo "    GET    ${SERVICE_URL}/health        - Health check"
