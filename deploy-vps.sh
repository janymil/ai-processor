#!/bin/bash

# VPS Docker deployment script for AI Processor
# Deploy to VPS instead of Fly.io

echo "🚀 Building and starting AI Processor with Docker on VPS..."

# Stop and remove existing containers
echo "📦 Stopping existing containers..."
docker-compose down

# Build and start the service
echo "🔨 Building Docker image..."
docker-compose build --no-cache

echo "▶️ Starting AI Processor service..."
docker-compose up -d

# Wait a moment for the service to start
sleep 5

# Check if the service is running
echo "🔍 Checking service health..."
if curl -f http://localhost:8080/health > /dev/null 2>&1; then
    echo "✅ AI Processor is running successfully!"
    echo "🌐 Service available at: http://your-vps-ip:8080"
    echo "🔗 Replace 'your-vps-ip' with your actual VPS IP address"
else
    echo "❌ Service health check failed. Check logs with: docker-compose logs"
fi

echo ""
echo "📋 Useful commands:"
echo "  View logs: docker-compose logs -f"
echo "  Stop service: docker-compose down"
echo "  Restart service: docker-compose restart"
echo "  Check running containers: docker ps"
