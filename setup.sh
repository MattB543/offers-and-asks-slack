#!/bin/bash

# Quick setup script for Offers and Asks Slack bot

echo "🚀 Starting Offers and Asks Bot Setup..."
echo "======================================="

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ .env file not found!"
    echo "Creating .env from template..."
    
    cat > .env << EOF
# Slack Configuration
SLACK_BOT_TOKEN=xoxb-your-token-here
SLACK_SIGNING_SECRET=your-signing-secret-here

# OpenAI Configuration  
OPENAI_API_KEY=sk-your-openai-key-here

# Database Configuration
DATABASE_URL=postgresql://user:password@localhost:5432/offers_asks_db

# Admin Configuration (comma-separated Slack user IDs)
ADMIN_USER_ID=U12345678

# Environment
NODE_ENV=development
PORT=3000
EOF
    
    echo "✅ Created .env file - please update with your actual values!"
    echo ""
    read -p "Press enter after updating .env file to continue..."
fi

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

# Build TypeScript
echo ""
echo "🔨 Building TypeScript..."
npm run build

# Setup database
echo ""
echo "🗄️ Setting up database..."
npm run setup-db

if [ $? -ne 0 ]; then
    echo "❌ Database setup failed!"
    echo "Please check your DATABASE_URL and PostgreSQL connection."
    exit 1
fi

# Seed initial skills
echo ""
echo "🌱 Seeding initial skills..."
npm run seed-skills seed-sample

if [ $? -ne 0 ]; then
    echo "⚠️ Skill seeding failed, but you can add skills manually later."
fi

# Success message
echo ""
echo "======================================="
echo "✅ Setup Complete!"
echo ""
echo "Next steps:"
echo "1. Make sure your Slack app is configured at https://api.slack.com/apps"
echo "2. Update the Request URL to: https://your-domain.com/slack/events"
echo "3. Start the bot:"
echo "   - Development: npm run dev"
echo "   - Production: npm start"
echo ""
echo "Admin features:"
echo "- Visit the app home to see admin controls"
echo "- Send weekly prompts manually from admin panel"
echo "- View statistics and manage the system"
echo ""
echo "🎉 Happy matching!"