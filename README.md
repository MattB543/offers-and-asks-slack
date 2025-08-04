# Helper Matcher Slack Bot 🤝

A Slack bot that intelligently matches team members who need help with those who have the right skills using AI embeddings and vector similarity search.

> **Latest Updates**: Fixed all deployment configuration issues, added proper Slack app manifest, optimized vector storage, and corrected OAuth scopes for production readiness.

## Features

- **Smart Skill Matching**: Uses OpenAI embeddings and PostgreSQL's pgvector for semantic similarity matching
- **Weekly Check-ins**: Automatically sends weekly DMs asking team members what they need help with
- **Skill Management**: Easy interface for team members to add and manage their skills
- **Real-time Matching**: Find helpers instantly through the app home or DM interactions
- **Admin Notifications**: Get notified of errors and system events

## Architecture

- **Slack Integration**: Bolt for JavaScript with Events API
- **Database**: PostgreSQL 15+ with pgvector extension for vector similarity search
- **AI**: OpenAI text-embedding-3-small for generating skill and need embeddings
- **Scheduling**: Bree for cron-based weekly prompts
- **Deployment**: Ready for DigitalOcean App Platform or Heroku

## Quick Start

> **🎯 Fastest Path**: Use the automated setup script: `./setup.sh`

### Prerequisites

- Node.js 18+
- PostgreSQL 15+ with pgvector extension
- Slack workspace with bot permissions
- OpenAI API key

> **💡 Cloud Deployment**: Skip local setup entirely! Deploy directly to DigitalOcean/Heroku/Railway and use their managed PostgreSQL.

### 1. Clone and Install

```bash
git clone <your-repo-url>
cd offers-and-asks-slack
npm install
```

### 2. Environment Setup

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required environment variables:
- `SLACK_BOT_TOKEN`: Your Slack bot token (xoxb-...)
- `SLACK_SIGNING_SECRET`: Your Slack app signing secret
- `OPENAI_API_KEY`: Your OpenAI API key
- `DATABASE_URL`: PostgreSQL connection string
- `ADMIN_USER_ID`: Slack user ID for admin notifications

### 3. Database Setup

```bash
# Set up database schema
npm run setup-db

# Seed with common skills (optional)
npm run seed-skills seed-sample
```

### 4. Slack App Configuration

**Option A: Use the App Manifest (Recommended)**
1. Create a new Slack app at https://api.slack.com/apps
2. Choose "From an app manifest"
3. Use the `slack-app-manifest.json` file in this repository
4. Update the `request_url` fields with your actual domain
5. Install the app to your workspace

**Option B: Manual Configuration**
1. Create a new Slack app at https://api.slack.com/apps
2. Configure OAuth scopes:
   - `chat:write`
   - `im:write` (required for DMs)
   - `conversations:open`
   - `users:read`
   - `channels:read`
   - `commands` (optional)
3. Enable Event Subscriptions:
   - Request URL: `https://your-app.example.com/slack/events`
   - Subscribe to: `app_home_opened`, `message.im`
4. Enable App Home:
   - Home Tab: Enabled
   - Messages Tab: Disabled
5. Enable Interactivity:
   - Request URL: `https://your-app.example.com/slack/events`
6. Install the app to your workspace

### 5. Run

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Usage

### For Team Members

1. **Add Skills**: Visit the app home to manage your skills
2. **Find Help**: 
   - Use the "Find Helpers" button in app home
   - Respond to weekly DM prompts
   - Send a DM to the bot
3. **Get Matched**: Receive personalized helper suggestions based on semantic similarity

### For Admins

- Monitor the bot through admin notifications
- View weekly statistics and usage patterns
- Manage skills database through seed scripts

## Commands

```bash
# Database management
npm run setup-db              # Initialize database schema
npm run seed-skills seed-sample    # Seed with common tech skills
npm run seed-skills seed <csv>     # Seed from CSV file
npm run seed-skills create-sample  # Create sample CSV template

# Development
npm run dev                   # Start in development mode
npm run build                 # Build TypeScript
npm start                     # Start production server

# Manual jobs
npm run weekly-prompt         # Run weekly prompt job manually
```

## Deployment

### 🚀 **Simple Deployment (Recommended)**

**DigitalOcean App Platform** ($3/month)
1. Fork this repository
2. Create new App → Connect GitHub repo
3. Set environment variables in dashboard
4. Deploy! (Auto-detected as Node.js app)

**Heroku** ($7/month)
1. Fork this repository  
2. Create new Heroku app → Connect GitHub
3. Add Heroku Postgres addon
4. Deploy! (One-click with `app.json`)

**Railway** ($5/month)
1. Connect GitHub repo
2. Add PostgreSQL service
3. Set environment variables
4. Deploy automatically

> **Zero complexity!** These platforms auto-detect Node.js and handle everything.


## Skills Management

### Adding Skills via CSV

Create a CSV file with columns: `skill`, `category` (optional), `description` (optional)

```csv
skill,category,description
JavaScript,Programming Languages,Dynamic programming language for web development
React,Frontend Frameworks,JavaScript library for building user interfaces
PostgreSQL,Databases,Open source relational database system
```

Then seed:

```bash
npm run seed-skills seed /path/to/your/skills.csv
```

### Skills Database Schema

- **skills**: Core skills with AI embeddings
- **people**: Slack users and their preferences
- **person_skills**: Many-to-many relationship between people and skills
- **weekly_needs**: Tracks help requests and their embeddings
- **helper_suggestions**: Logs all matching suggestions for analytics

## Monitoring

- Health check endpoint: `/health`
- Admin notifications for errors and system events
- Weekly job summaries
- Built-in error handling and retry logic

## API Endpoints

- `POST /slack/events` - Slack Events API webhook
- `GET /health` - Health check endpoint

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

ISC License - see LICENSE file for details.

## Support

For issues and questions:
1. Check the troubleshooting section below
2. Open an issue on GitHub
3. Check Slack app logs for error messages

## Troubleshooting

### Common Issues

**Database Connection Issues**
- Ensure PostgreSQL is running and accessible
- Verify DATABASE_URL is correct
- Check that pgvector extension is installed: `CREATE EXTENSION vector;`

**Slack Events Not Received**
- Verify your app's Request URL is publicly accessible
- Check Slack app configuration and permissions
- Ensure SLACK_SIGNING_SECRET is correct

**OpenAI API Issues**
- Verify OPENAI_API_KEY is valid and has sufficient credits
- Check rate limits if processing many skills at once

**Weekly Jobs Not Running**
- Check server logs for Bree scheduler errors
- Verify timezone configuration for cron jobs
- Ensure the server stays running (use PM2 or similar in production)

### Debug Mode

Set `NODE_ENV=development` to:
- Disable admin error notifications
- Get more verbose logging
- Enable development-specific features

---

Built with ❤️ using Slack Bolt, PostgreSQL, OpenAI, and TypeScript.