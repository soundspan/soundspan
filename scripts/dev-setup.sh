#!/bin/bash
# Development environment setup script
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "🚀 Setting up soundspan development environment..."

# Check if .env exists
if [ ! -f backend/.env ]; then
    echo "📝 Creating backend/.env from .env.example..."
    if [ ! -f .env.example ]; then
        echo "❌ .env.example not found"
        exit 1
    fi
    cp .env.example backend/.env
    # Backend dev uses 3007 in our local +1 port convention.
    sed -i 's/^PORT=3030$/PORT=3007/' backend/.env
    echo "⚠️  Please update backend/.env with your configuration"
fi

if ! command -v nc >/dev/null 2>&1; then
    echo "❌ 'nc' (netcat) is required but not installed"
    exit 1
fi

# Check PostgreSQL
echo "🔍 Checking PostgreSQL (port 5433)..."
if ! nc -z localhost 5433 2>/dev/null; then
    echo "❌ PostgreSQL not running on port 5433"
    echo "   Start with: docker compose -f docker-compose.local.yml up -d postgres-local"
    exit 1
fi

# Check Redis
echo "🔍 Checking Redis (port 6380)..."
if ! nc -z localhost 6380 2>/dev/null; then
    echo "❌ Redis not running on port 6380"
    echo "   Start with: docker compose -f docker-compose.local.yml up -d redis-local"
    exit 1
fi

echo "✅ All services are running!"
echo "📦 Installing dependencies..."
npm --prefix backend install

echo "🎉 Setup complete!"
echo "   Recommended local dev start:"
echo "   1) cd backend && PORT=3007 npm run dev"
echo "   2) cd frontend && PORT=3031 BACKEND_URL=http://127.0.0.1:3007 npm run dev"
