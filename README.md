# FinanzerPro AI Processor Service

A standalone Node.js microservice for handling OpenAI API calls for FinanzerPro's AI financial tips generation.

## Architecture

This service offloads heavy OpenAI API computations from the main application to your VPS infrastructure using Docker, while maintaining complete data sovereignty in the main application.

## API Endpoints

- `GET /health` - Health check endpoint
- `POST /generate-financial-tip` - Generates AI financial recommendations

### POST /generate-financial-tip

**Request:**
```json
{
  "summary": "Financial Summary: Monthly Income: $5000, Monthly Expenses: $3500..."
}
```

**Response:**
```json
{
  "tip": {
    "title": "Advanced Financial Analysis: [Focus Area]",
    "description": "Detailed analysis with specific recommendations...",
    "category": "spending|saving|budgeting|income|education",
    "priority": "high|medium|low",
    "actionable": true,
    "estimatedSaving": 2520,
    "educational": false
  }
}
```

## Deployment to VPS

### Prerequisites
1. VPS with Docker and Docker Compose installed
2. OpenAI API Key

### Quick Deploy
```bash
# Make deployment script executable
chmod +x deploy-vps.sh

# Deploy the service
./deploy-vps.sh
```

### Manual Deployment
```bash
# Create .env file with your OpenAI API key
echo "OPENAI_API_KEY=your_openai_api_key_here" > .env

# Build and start with Docker Compose
docker-compose up -d

# Check service health
curl http://localhost:8080/health
```

### Set Environment Variables
Create a `.env` file in the project root:
```env
OPENAI_API_KEY=your_openai_api_key_here
PORT=8080
NODE_ENV=production
```

## Environment Variables

- `OPENAI_API_KEY` - OpenAI API key for GPT-4o access
- `PORT` - Server port (default: 8080)
- `NODE_ENV` - Environment mode (production for VPS deployment)

## Local Development

```bash
npm start
```

Test endpoints:
```bash
curl http://localhost:8080/health
curl -X POST http://localhost:8080/generate-financial-tip -H "Content-Type: application/json" -d '{"summary": "..."}'
```

## VPS Management Commands

```bash
# View logs
docker-compose logs -f

# Stop service
docker-compose down

# Restart service
docker-compose restart

# Check running containers
docker ps

# Update deployment
./deploy-vps.sh
```