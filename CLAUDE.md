# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Slack bot that matches team members needing help with those who have relevant skills using AI embeddings and vector similarity search. Built with TypeScript, Slack Bolt framework, PostgreSQL with pgvector, and OpenAI embeddings.

## Key Commands

### Development
```bash
npm run dev          # Start development server with ts-node
npm run build        # Compile TypeScript to dist/
npm start           # Run production server from dist/
```

### Database Operations
```bash
npm run setup-db              # Initialize database schema with pgvector extension
npm run seed-skills seed-sample    # Seed with common tech skills
npm run seed-skills seed <csv>     # Seed skills from CSV file
npm run seed-skills create-sample  # Create sample CSV template
```

### Manual Jobs
```bash
npm run weekly-prompt         # Manually trigger weekly DM prompts
```

## Architecture

### Core Components

**Slack Integration (src/app.ts)**
- Event handlers for app_home_opened, DMs, and button interactions
- Modal interfaces for skill management and help requests
- Uses Slack Bolt framework with socket mode disabled (webhook-based)

**Database Layer (src/lib/database.ts)**
- PostgreSQL connection with pgvector extension for similarity search
- Dynamic SSL configuration for DigitalOcean/production environments
- Key tables: skills (with embeddings), people, person_skills, weekly_needs

**AI Services (src/lib/openai.ts)**
- OpenAI text-embedding-3-small model for generating embeddings
- Handles conversion of skills and needs into vector representations

**Matching Service (src/services/matching.ts)**
- Vector similarity search using cosine distance
- Groups and ranks helpers by skill relevance
- Excludes requester from results

### Data Flow
1. User describes need → OpenAI generates embedding
2. Embedding compared against skill embeddings in PostgreSQL using pgvector
3. Top matches grouped by person and returned with relevant skills
4. Results formatted and sent via Slack DM

## Environment Variables

Required in `.env`:
- `SLACK_BOT_TOKEN`: xoxb-... token from Slack app
- `SLACK_SIGNING_SECRET`: For request verification
- `OPENAI_API_KEY`: For embeddings generation
- `DATABASE_URL`: PostgreSQL connection string
- `ADMIN_USER_ID`: Slack user ID for error notifications
- `NODE_ENV`: Set to "production" for SSL database connections

## TypeScript Configuration

- Target: ES2022, Module: CommonJS
- Strict mode enabled
- Source in `src/`, output to `dist/`
- Source maps and declarations generated

## Database Schema

Uses PostgreSQL with pgvector extension:
- `skills`: skill text + embedding vector (1536 dimensions)
- `people`: Slack users with enabled flag
- `person_skills`: Many-to-many relationships
- `weekly_needs`: Tracked help requests with embeddings
- Vector similarity operations use `<=>` operator for cosine distance

## Deployment Notes

- Requires PostgreSQL 15+ with pgvector extension
- SSL automatically configured for production/DigitalOcean deployments
- Health check endpoint at `/health`
- Slack webhooks at `/slack/events`
- Uses Bree for scheduled jobs (weekly prompts)