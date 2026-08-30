#!/bin/bash
set -eo pipefail

echo "=================================================="
echo " Starting Integration Test for CollabMind AI "
echo "=================================================="

# 1. Start Services
echo "Starting services..."
docker-compose up -d db redis
sleep 5 # Wait for DB and Redis to be ready

# You should start backend and ai in separate terminals or background, 
# for the script we assume they are already running locally or we could start them:
# (cd backend && npm start &)
# (cd ai && uvicorn main:app --port 8000 &)
# sleep 5

API_URL="http://localhost:4000/api"

# Generate a mock Google JWT (since we bypass actual Google for local tests if auth supports it, 
# or we use a hardcoded test token. Assuming authController accepts test tokens or we need to bypass).
# For testing purposes, assuming the backend can issue a token if we POST to auth/google with a test token.
echo "1. Getting JWT via /auth/google..."
# Actually we might need a real token or mock token from backend
TOKEN=$(curl -s -X POST $API_URL/auth/google \
  -H "Content-Type: application/json" \
  -d '{"token":"test-token"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "Failed to get token! Ensure backend accepts the mock token."
  # Mock token for manual testing if backend skips auth locally
  export TOKEN="mock-token-for-testing"
fi

AUTH_HEADER="Authorization: Bearer $TOKEN"

echo "2. Creating a Workspace..."
WORKSPACE_RES=$(curl -s -X POST $API_URL/workspaces \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{"name": "Integration Test WorkSpace", "description": "Testing RAG & Agents"}')

echo $WORKSPACE_RES
W_ID=$(echo $WORKSPACE_RES | grep -o '"id":"[^"]*' | cut -d'"' -f4)

if [ -z "$W_ID" ]; then
  echo "Failed to create workspace."
  exit 1
fi

echo "Workspace ID: $W_ID"

echo "3. Uploading a URL Source..."
URL_RES=$(curl -s -X POST $API_URL/workspaces/$W_ID/sources/url \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{"url":"https://example.com/test-article"}')
echo $URL_RES

sleep 2

echo "4. Sending a Chat Message..."
CHAT_RES=$(curl -s -X POST $API_URL/workspaces/$W_ID/chat \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{"message":"summarize my sources", "conversation_history": []}')
echo $CHAT_RES

echo "5. Triggering Study Coach Agent..."
AGENT_RES=$(curl -s -X POST $API_URL/workspaces/$W_ID/agents/study-coach \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{"goal":"prepare for exam"}')
echo $AGENT_RES
RUN_ID=$(echo $AGENT_RES | grep -o '"run_id":"[^"]*' | cut -d'"' -f4)

if [ -z "$RUN_ID" ]; then
  echo "Failed to trigger agent."
  exit 1
fi

sleep 2

echo "6. Polling Agent Status..."
STATUS_RES=$(curl -s -X GET $API_URL/workspaces/$W_ID/agents/$RUN_ID/status \
  -H "$AUTH_HEADER")
echo $STATUS_RES

echo "=================================================="
echo " Tests Complete! "
echo "=================================================="
