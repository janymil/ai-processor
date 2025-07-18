# FinanzerPro AI Processor Service

A standalone Node.js microservice for handling OpenAI API calls for FinanzerPro's AI financial tips generation.

## Architecture

This service offloads heavy OpenAI API computations from the main Replit app to Fly.io infrastructure while maintaining complete data sovereignty in the main application.

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

## Deployment to Fly.io

1. Install Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. Login: `fly auth login`
3. Deploy: `fly deploy`
4. Set secrets: `fly secrets set OPENAI_API_KEY=your_key_here`

## Environment Variables

- `OPENAI_API_KEY` - OpenAI API key for GPT-4o access
- `PORT` - Server port (default: 3000, Fly.io uses 8080)

## Local Development

```bash
node server.js
```

Test endpoints:
```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/generate-financial-tip -H "Content-Type: application/json" -d '{"summary": "..."}'
```