# Stop Docker deployment script for AI Processor

Write-Host "🛑 Stopping AI Processor Docker service..." -ForegroundColor Yellow

docker-compose down

Write-Host "✅ AI Processor service stopped!" -ForegroundColor Green
