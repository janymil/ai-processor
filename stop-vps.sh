#!/bin/bash

# Stop Docker deployment script for AI Processor on VPS

echo "🛑 Stopping AI Processor Docker service..."

docker-compose down

echo "✅ AI Processor service stopped!"
