#!/bin/bash

# Helper Matcher Slack Bot Setup Script
# This script helps you get the MVP up and running quickly

set -e

echo "🚀 Setting up Helper Matcher Slack Bot..."

# Check if required commands exist
check_command() {
    if ! command -v $1 &> /dev/null; then
        echo "❌ $1 is not installed. Please install it first."
        exit 1
    fi
}

echo "🔍 Checking prerequisites..."
check_command node
check_command npm
check_command psql

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ $NODE_VERSION -lt 18 ]; then
    echo "❌ Node.js 18+ required. Current version: $(node --version)"
    exit 1
fi

echo "✅ Prerequisites check passed"

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
else
    echo "✅ Dependencies already installed"
fi

# Build the project
echo "🔨 Building TypeScript..."
npm run build

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "📝 Creating .env file from template..."
    cp .env.example .env
    echo "⚠️  Please edit .env file with your actual credentials:"
    echo "   - SLACK_BOT_TOKEN"
    echo "   - SLACK_SIGNING_SECRET" 
    echo "   - OPENAI_API_KEY"
    echo "   - DATABASE_URL"
    echo "   - ADMIN_USER_ID"
    echo ""
    echo "Press Enter when you've updated the .env file..."
    read
fi

# Verify environment variables are set
echo "🔍 Checking environment variables..."
source .env

required_vars=("SLACK_BOT_TOKEN" "SLACK_SIGNING_SECRET" "OPENAI_API_KEY" "DATABASE_URL")
missing_vars=()

for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        missing_vars+=($var)
    fi
done

if [ ${#missing_vars[@]} -ne 0 ]; then
    echo "❌ Missing required environment variables:"
    printf '   - %s\n' "${missing_vars[@]}"
    echo "Please update your .env file and run this script again."
    exit 1
fi

echo "✅ Environment variables check passed"

# Test database connection and setup schema
echo "🗄️  Setting up database..."
if npm run setup-db; then
    echo "✅ Database setup completed"
else
    echo "❌ Database setup failed. Please check your DATABASE_URL and ensure:"
    echo "   - PostgreSQL is running and accessible"
    echo "   - The database exists"
    echo "   - pgvector extension is available"
    echo "   - User has necessary permissions"
    exit 1
fi

# Offer to seed skills
echo ""
echo "🌱 Would you like to seed the database with common tech skills? (y/N)"
read -r response
if [[ "$response" =~ ^[Yy]$ ]]; then
    echo "🌱 Seeding skills..."
    npm run seed-skills seed-sample
    echo "✅ Skills seeded successfully"
fi

echo ""
echo "🎉 Setup completed successfully!"
echo ""
echo "Next steps:"
echo "1. Configure your Slack app at https://api.slack.com/apps"
echo "   - Set Request URL to: https://your-domain.com/slack/events"
echo "   - Add required OAuth scopes (see README.md)"
echo "   - Subscribe to bot events (see README.md)"
echo ""
echo "2. Start the server:"
echo "   Development: npm run dev"
echo "   Production:  npm start"
echo ""
echo "3. Install the app to your Slack workspace"
echo ""
echo "📚 For detailed instructions, see README.md"
echo "🐛 For issues, check the troubleshooting section in README.md"