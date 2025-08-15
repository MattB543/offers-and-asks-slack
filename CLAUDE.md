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
npm run channel-summaries     # Generate channel summaries
npm run rebuild-person-skills # Rebuild person-skill relationships
```

### Search and Analytics
```bash
npm run audit-person-skills           # Audit person-skill rebuild process
npm run backfill-message-embeddings  # Backfill embeddings for slack messages
npm run build-search-index           # Build search index
npm run nightly-ingest               # Run nightly data ingestion
```

### Document Processing
```bash
npm run process-documents       # Process Drive documents in data/drive_docs/
npm run process-documents-force # Force reprocess all documents (ignore existing)
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

**Search Services**
- **Unified Search (src/services/unifiedSearch.ts)**: Searches across Slack messages and Drive documents
- **Hybrid Search (src/services/hybridSearch.ts)**: Combines semantic and keyword search
- **BM25 Index (src/services/bm25Index.ts)**: Traditional keyword search indexing
- **Cohere Reranker (src/services/cohereReranker.ts)**: AI-powered result reranking
- **Keyword Search Bridge (src/services/keywordSearchBridge.ts)**: Interface between search systems

**Document Processing**
- **Document Parser (src/services/documentParser.ts)**: Hierarchical parsing of markdown documents
- **Document Processing Script (src/scripts/process-drive-documents.ts)**: Batch processing of Drive docs

**OAuth Service (src/services/oauth.ts)**
- Multi-tenant Slack app installation management
- Token management for multiple workspaces

### Data Flow

**Primary Matching Flow**
1. User describes need → OpenAI generates embedding
2. Embedding compared against skill embeddings in PostgreSQL using pgvector
3. Top matches grouped by person and returned with relevant skills
4. Results formatted and sent via Slack DM

**Search Flow**
1. User query → Unified search across Slack messages and Drive documents
2. Semantic similarity using OpenAI embeddings (cosine distance)
3. Optional Cohere reranking for optimal result ordering
4. Results combined and ranked by relevance scores
5. Hierarchical document context available for detailed exploration

**Document Processing Flow**
1. Markdown files placed in `data/drive_docs/` folder
2. Document parser extracts title, sections, and metadata
3. Hierarchical chunking: large sections split semantically, small sections kept whole
4. OpenAI embeddings generated for each chunk and document summary
5. All chunks stored in database with full-text search support
6. Documents immediately available for unified search

**Multi-tenant Flow**
1. Slack workspace installs app via OAuth
2. Installation details stored in tenants table
3. App operates independently per workspace
4. Token management handled automatically

## Environment Variables

**Always Required:**
- `SLACK_SIGNING_SECRET`: For request verification
- `OPENAI_API_KEY`: For embeddings generation
- `DATABASE_URL`: PostgreSQL connection string

**Choose One Authentication Method:**

*Single Workspace (Bot Token):*
- `SLACK_BOT_TOKEN`: xoxb-... token from Slack app

*Multi-Workspace (OAuth):*
- `SLACK_CLIENT_ID`: OAuth client ID
- `SLACK_CLIENT_SECRET`: OAuth client secret

**Optional:**
- `ADMIN_USER_ID`: Slack user ID for error notifications
- `NODE_ENV`: Set to "production" for SSL database connections
- `PORT`: Server port (default: 3000)
- `COHERE_API_KEY`: For search result reranking

## TypeScript Configuration

- Target: ES2022, Module: CommonJS
- Strict mode enabled
- Source in `src/`, output to `dist/`
- Source maps and declarations generated

## Database Schema

Uses PostgreSQL with pgvector extension:

**Core Tables:**
- `skills`: skill text + embedding vector (1536 dimensions)
- `people`: Slack users with profile fields (expertise, projects, asks, offers)
- `person_skills`: Many-to-many relationships
- `weekly_needs`: Help requests with embeddings and processing metadata

**Multi-tenant Support:**
- `tenants`: OAuth installations per Slack workspace
- `slack_channel_profiles`: Channel summaries and membership

**Search & Analytics:**
- `slack_export`: Raw Slack data exports
- `slack_channel_export`: Channel-level export metadata
- `slack_message`: Individual messages with embeddings
- `index_state`: Search index status tracking
- `ingestion_log`: Processing history and metrics

**Document Storage:**
- `documents`: Drive document metadata, summaries, and processing status
- `document_embeddings`: Hierarchical document chunks with embeddings
- `document_chunks_with_metadata` (view): Simplified access to document content

**Helper Tables:**
- `helper_suggestions`: Tracks all matching suggestions for analytics
- Vector similarity operations use `<=>` operator for cosine distance
- HNSW indexes available for performance (commented out by default)

## Deployment Notes

- Requires PostgreSQL 15+ with pgvector extension
- SSL automatically configured for production/DigitalOcean deployments
- Health check endpoint at `/health`
- Slack webhooks at `/slack/events`
- OAuth endpoints at `/slack/install` and `/slack/oauth_redirect` (if OAuth enabled)
- External API endpoints under `/external` path
- Job scheduler disabled by default - weekly prompts are manual via admin controls
- Supports both single-workspace (bot token) and multi-workspace (OAuth) modes

## Key File Locations

**Entry Points:**
- `src/server.ts`: Main server with health checks and startup logic
- `src/app.ts`: Slack app configuration and event handlers

**Core Scripts:**
- `src/scripts/setup-database.ts`: Database schema initialization
- `src/scripts/seed-skills.ts`: Skills data management
- `database/schema.sql`: Complete database schema

**Background Jobs:**
- `src/jobs/weekly-prompt.ts`: Weekly help request prompts
- `src/jobs/channel-summaries.ts`: Channel summarization
- `src/jobs/rebuild-person-skills.ts`: Skill relationship rebuilding

**Document Processing:**
- `src/scripts/process-drive-documents.ts`: Batch document processing
- `src/services/documentParser.ts`: Document parsing and chunking service
- `src/services/unifiedSearch.ts`: Unified search across all content types
- `scripts/add-document-storage.sql`: Database migration for document storage