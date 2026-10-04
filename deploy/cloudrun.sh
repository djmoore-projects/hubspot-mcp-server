#!/usr/bin/env bash
# One-command deploy to Google Cloud Run.
#   PROJECT=my-gcp-project REGION=us-central1 SECRETS="HUBSPOT_TOKEN_ACME=hubspot-token-acme:latest" ./deploy/cloudrun.sh
# SECRETS maps env vars to Secret Manager secrets; create each first with:
#   printf 'pat-xxxx' | gcloud secrets create hubspot-token-acme --data-file=-
set -euo pipefail
: "${PROJECT:?set PROJECT}" "${REGION:=us-central1}" "${SERVICE:=hubspot-mcp}" "${SECRETS:?set SECRETS}"
ENV_FILE="$(dirname "$0")/cloudrun.env.yaml"
[[ -f "$ENV_FILE" ]] || { echo "Create $ENV_FILE from deploy/cloudrun.env.example.yaml first" >&2; exit 1; }

# --allow-unauthenticated: Cloud Run IAM would block OAuth clients; every route except
# /healthz and the OAuth metadata is authenticated by the app's own JWT validation.
# --max-instances 1: approvals and rate limits are in-memory (see README "Scaling out").
gcloud run deploy "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --source "$(dirname "$0")/.." \
  --allow-unauthenticated \
  --env-vars-file "$ENV_FILE" \
  --set-secrets "$SECRETS" \
  --min-instances 1 --max-instances 1 \
  --cpu 1 --memory 512Mi --concurrency 80 --timeout 60 \
  --port 8080

echo "MCP endpoint: $(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')/mcp"
