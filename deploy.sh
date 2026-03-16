#!/bin/bash

# Configuration
PROJECT_ID=$(gcloud config get-value project)
SERVICE_NAME="senti-app"
REGION="us-central1"

echo "🚀 Deploying $SERVICE_NAME to Google Cloud Run in $REGION..."

# Build and Push using Cloud Build
if [ -z "$NEXT_PUBLIC_TLDRAW_LICENSE_KEY" ]; then
  echo "⚠️  Warning: NEXT_PUBLIC_TLDRAW_LICENSE_KEY is not set in your environment."
  echo "The app will build without a license key."
fi

gcloud builds submit --tag gcr.io/$PROJECT_ID/$SERVICE_NAME \
  --build-arg NEXT_PUBLIC_TLDRAW_LICENSE_KEY=$NEXT_PUBLIC_TLDRAW_LICENSE_KEY

# Deploy to Cloud Run
gcloud run deploy $SERVICE_NAME \
  --image gcr.io/$PROJECT_ID/$SERVICE_NAME \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated

echo "✅ Deployment complete!"
