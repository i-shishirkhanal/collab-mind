#!/bin/bash
# Start all CollabMind AI app services (DB + Redis must already be up via Docker)
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

check_port() {
  nc -z localhost "$1" 2>/dev/null
}

echo "Checking DB (5432) and Redis (6379)..."
if ! check_port 5432 || ! check_port 6379; then
  echo ""
  echo "  ERROR: PostgreSQL or Redis is not running."
  echo "  Start them first:"
  echo ""
  echo "    sudo docker-compose -f \"$ROOT/docker-compose.yml\" up -d db redis"
  echo ""
  exit 1
fi
echo "  DB and Redis are up."

echo ""
echo "Starting Backend (port 4000)..."
cd "$ROOT/backend"
npm start &
BACKEND_PID=$!

echo "Starting AI Service (port 8000)..."
cd "$ROOT/ai"
source .venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
AI_PID=$!

echo "Starting Frontend (port 3000)..."
cd "$ROOT/frontend"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "=================================================="
echo "  CollabMind AI is starting up"
echo "  Frontend  → http://localhost:3000"
echo "  Backend   → http://localhost:4000"
echo "  AI        → http://localhost:8000/docs"
echo "=================================================="
echo ""
echo "Press Ctrl+C to stop all services."

trap "echo 'Stopping...'; kill $BACKEND_PID $AI_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM
wait
