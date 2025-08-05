# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Slack bot called "Helper Matcher" that uses AI embeddings and vector similarity search to intelligently match team members who need help with those who have the right skills. It's built with TypeScript, uses PostgreSQL with pgvector for vector storage, and integrates with OpenAI for generating embeddings.

## Core Architecture

- **Entry Point**: `src/server.ts` - Main server class that initializes database, health checks, job scheduler, and Slack app
- **Slack Integration**: `src/app.ts` - Slack Bolt app with event handlers for app home, modals, and DMs
- **Database Layer**: `src/lib/database.ts` - PostgreSQL client with pgvector support for vector similarity searches
- **AI Integration**: `src/lib/openai.ts` - OpenAI service for generating text embeddings
- **Matching Service**: `src/services/matching.ts` - Core logic for finding helpers using vector similarity
- **Background Jobs**: `src/jobs/weekly-prompt.ts` - Bree scheduler for weekly check-ins
- **Database Schema**: `database/schema.sql` - PostgreSQL schema with vector extension and HNSW indexes

## Development Commands

```bash
# Development
npm run dev                    # Start in development mode with ts-node
npm run build                  # Compile TypeScript to dist/
npm start                      # Start production server from dist/

# Database Management
npm run setup-db               # Initialize database schema from schema.sql
npm run seed-skills seed-sample # Seed with common tech skills
npm run seed-skills seed <csv>  # Seed from custom CSV file

# Manual Jobs
npm run weekly-prompt          # Run weekly prompt job manually

# Quick Setup
./setup.sh                     # Automated setup script with checks
```

## Database Architecture

Uses PostgreSQL 15+ with pgvector extension for semantic similarity search:

- **people**: Stores Slack users with preferences
- **skills**: Stores skills with 1536-dimension OpenAI embeddings
- **person_skills**: Many-to-many relationship between people and skills
- **weekly_needs**: Tracks help requests with embeddings for matching

Vector similarity uses cosine distance with HNSW indexes for performance.

## Environment Requirements

Required environment variables in `.env`:

- `SLACK_BOT_TOKEN`: Slack bot token (xoxb-...)
- `SLACK_SIGNING_SECRET`: Slack app signing secret
- `OPENAI_API_KEY`: OpenAI API key for embeddings
- `DATABASE_URL`: PostgreSQL connection string
- `ADMIN_USER_ID`: Slack user ID for admin notifications

## Key Integration Points

- **Slack Events**: App home, DMs, button interactions, modal submissions
- **Vector Search**: Uses OpenAI text-embedding-3-small model (1536 dimensions)
- **Job Scheduling**: Bree scheduler runs weekly prompts on Monday 9am EST
- **Error Handling**: Centralized error handler with admin notifications

## Development Notes

- Server uses graceful shutdown handling for SIGINT/SIGTERM
- Health checks validate database, OpenAI, and environment variables on startup
- Database schema initialization is handled separately via `npm run setup-db` (not on server startup)
- All database operations use connection pooling with simplified DATABASE_URL-only configuration
- Vector embeddings are generated on-demand for new skills
- Matching algorithm groups results by person and ranks by similarity score
- Weekly prompt jobs use lightweight WebClient instead of full Bolt App instance
- Modal UI components are refactored to avoid code duplication
