#!/bin/bash
# Development environment setup script

echo "🚀 Setting up soundspan development environment..."

# Check if .env exists
if [ ! -f backend/.env ]; then
    echo "📝 Creating backend/.env from .env.example..."
    cp .env.example backend/.env
    # Backend dev uses 3007 in our local +1 port convention.
    sed -i 's/^PORT=3030$/PORT=3007/' backend/.env
    echo "⚠️  Please update backend/.env with your configuration"
fi

# Check PostgreSQL
echo "🔍 Checking PostgreSQL (port 5433)..."
if ! nc -z localhost 5433 2>/dev/null; then
    echo "❌ PostgreSQL not running on port 5433"
    echo "   Start with: docker compose -f docker-compose.local.yml up -d postgres"
    exit 1
fi

# Check Redis
echo "🔍 Checking Redis (port 6380)..."
if ! nc -z localhost 6380 2>/dev/null; then
    echo "❌ Redis not running on port 6380"
    echo "   Start with: docker compose -f docker-compose.local.yml up -d redis"
    exit 1
fi

echo "✅ All services are running!"
echo "📦 Installing dependencies..."
cd backend && npm install && cd ..

echo "🎉 Setup complete!"
echo "   Recommended local dev start:"
echo "   1) cd backend && PORT=3007 npm run dev"
echo "   2) cd frontend && PORT=3031 BACKEND_URL=http://127.0.0.1:3007 npm run dev"
