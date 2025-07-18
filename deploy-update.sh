#!/bin/bash

# Force deployment of updated AI processor to Fly.io
echo "Deploying updated FinanzerPro AI Processor..."

# Create a temporary deployment directory with just the files we need
mkdir -p /tmp/fly-deploy
cp package.json /tmp/fly-deploy/
cp index.ts /tmp/fly-deploy/
cp openai-functions.ts /tmp/fly-deploy/
cp Dockerfile /tmp/fly-deploy/
cp fly.toml /tmp/fly-deploy/

cd /tmp/fly-deploy

# Deploy from temporary directory
echo "Starting deployment..."
docker build -t finanserpro-ai-processor .

echo "Deployment files prepared. Manual deployment required:"
echo "1. Navigate to: /tmp/fly-deploy"
echo "2. Run: fly deploy"
echo "3. Verify: curl https://finanserpro-ai-processor.fly.dev/health"

# Cleanup
echo "Temporary files created in /tmp/fly-deploy"