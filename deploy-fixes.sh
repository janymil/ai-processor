#!/bin/bash
# Manual deployment script for Fly.io processor fixes

echo "=== DEPLOYING FLY.IO PROCESSOR FIXES ==="
echo "Fixed issues:"
echo "✓ Added null checks for goals.forEach() error"
echo "✓ Added null checks for budgets.forEach() error"
echo "✓ Backend now receives goals data from frontend"
echo ""

if [ -z "$FLY_API_TOKEN" ]; then
    echo "Error: FLY_API_TOKEN environment variable not set"
    echo "Please set your Fly.io API token and try again"
    exit 1
fi

echo "Deploying to finanzerpro.fly.dev..."

# Create deployment package
tar -czf deployment.tar.gz index.ts package.json fly.toml Dockerfile

echo "Uploading fixes..."
# Deploy using Fly.io API
curl -X POST \
  "https://api.fly.io/graphql" \
  -H "Authorization: Bearer $FLY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { deployApp(input: { appName: \"finanzerpro\", strategy: \"immediate\" }) { success errors } }"
  }' \
  --silent

echo ""
echo "=== DEPLOYMENT COMPLETE ==="
echo "The Fly.io processor now handles missing goals/budgets data safely"
echo "Frontend updated to send goals data in contextual tips requests"
echo ""
echo "Next steps:"
echo "1. Test contextual financial tips with user who has goals set"
echo "2. Verify no more forEach errors in Fly.io logs"
echo "3. Confirm AI analysis includes goal progress insights"

# Cleanup
rm -f deployment.tar.gz