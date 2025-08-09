## V2 Feature: Channel Summaries and Membership Index

### Goal

- Generate a succinct 3‑sentence summary for every Slack channel represented in our database of Slack messages.
- Store these summaries in a new table along with the channel’s current member list (fetched via the Slack API).
- Make the job idempotent and re-runnable for periodic refreshes.

### Why

- Quick, actionable context for channels (useful for onboarding and discovery).
- Foundation for future features: channel recommendations, routing help requests, labeling/tagging channels.

---

### Current State (as of V1)

- We can ingest Slack export–shaped payloads via `/external/slack-message` and persist:
  - `slack_export` (top-level export metadata, JSON stored)
  - `slack_channel_export` (per-channel metadata in an export)
  - `slack_message` (messages with `channel_id`, `channel_name`, `ts`, `user_id`, `text`, `raw` JSON, etc.)
  - Note: these tables are referenced in code but not present in `database/schema.sql`. We should formalize them in schema/migrations.
- We have Slack API usage and tokens; job scheduler is manual-first.
- OpenAI is integrated (embeddings + skill extraction). No existing summarization utility yet.

---

### New Data Model

1. Backfill missing tables that our code already uses (to make them first-class):

   - `slack_export`
     - `id SERIAL PRIMARY KEY`
     - `collection_time TEXT NULL` (or `TIMESTAMP NULL` if desired)
     - `raw JSONB NOT NULL`
     - `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
   - `slack_channel_export`
     - `id SERIAL PRIMARY KEY`
     - `export_id INT REFERENCES slack_export(id) ON DELETE CASCADE`
     - `channel_id TEXT NOT NULL`
     - `channel_name TEXT NULL`
     - `message_count INT NULL`
     - `thread_replies_count INT NULL`
     - `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
     - `UNIQUE(export_id, channel_id)`
   - `slack_message`
     - `export_id INT REFERENCES slack_export(id) ON DELETE CASCADE`
     - `channel_export_id INT REFERENCES slack_channel_export(id) ON DELETE CASCADE`
     - `channel_id TEXT NOT NULL`
     - `channel_name TEXT NULL`
     - `ts TEXT NOT NULL` (Slack message timestamps are stringy; used as unique key with channel)
     - `user_id TEXT NULL`
     - `text TEXT NULL`
     - `message_type TEXT NULL`
     - `subtype TEXT NULL`
     - `thread_ts TEXT NULL`
     - `is_reply BOOLEAN NULL`
     - `parent_ts TEXT NULL`
     - `raw JSONB NOT NULL`
     - `PRIMARY KEY(channel_id, ts)`
     - Indexes: `(channel_id)`, `(channel_id, ts)` (covered by PK)

2. New table for summaries and membership:
   - `slack_channel_profiles`
     - `channel_id TEXT PRIMARY KEY`
     - `channel_name TEXT NULL`
     - `team_id TEXT NULL REFERENCES tenants(team_id)` (nullable to support current single-tenant mode)
     - `summary TEXT NOT NULL` (3 sentences)
     - `summary_model TEXT NULL` (e.g., `gpt-5-mini`)
     - `summary_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
     - `member_ids TEXT[] NOT NULL DEFAULT '{}'` (array of Slack user IDs)
     - `member_count INT GENERATED ALWAYS AS (cardinality(member_ids)) STORED` (optional; otherwise maintain explicitly)
     - `members_synced_at TIMESTAMP NULL`
     - `metadata JSONB NULL` (room for future fields like purpose/topic, recency stats)
     - `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
     - `updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
     - Trigger to auto-update `updated_at` (similar to `people`)

---

### Slack Scopes and API

- To fetch channel membership we’ll use `conversations.members` (and optionally `conversations.list` to enumerate channels if needed).
- Update app scopes if needed:
  - Ensure `channels:read` (public channels; already present in manifest)
  - Add `groups:read` (for private channels, if we want to include them and the bot is a member)
  - Keep existing: `users:read`, `chat:write`, `im:write`, `commands`
- Notes:
  - The bot must be a member of private channels to see their members; otherwise we’ll only populate public channels.
  - Pagination handling for member and channel listings.

---

### Summarization Design

- Source: messages in `slack_message` grouped by `channel_id`.
- Input selection:
  - Default: Use most recent N messages (e.g., 300–1000) and optionally include channel purpose/topic if we fetch it later.
  - Sanitize to remove URLs/user mentions/emojis noise where possible; truncate to a token budget.
- Prompting:
  - System prompt: “You are summarizing the purpose and typical content of a Slack channel. Produce 3 sentences, concise and general, avoiding proper names unless they indicate topics.”
  - User content: batched sample of representative messages.
- Model: `gpt-5-mini` or similar cost-effective model; tune temperature low (0–0.3).
- Output: plain text

---

### Job: Build/Refresh Channel Profiles

- Location: `src/jobs/channel-summaries.ts`
- Steps per run:

  1. Query distinct `channel_id, max(channel_name)` from `slack_message`.
  2. For each channel (batched, e.g., 10–20 concurrent):
     - Load a sample window of recent messages from `slack_message`.
     - Generate 3-sentence summary via OpenAI.
     - Fetch members via Slack API `conversations.members` (with pagination).
     - Upsert into `slack_channel_profiles`:
       - `channel_id`, `channel_name`, `summary`, `summary_model`, `summary_updated_at=NOW()`, `member_ids`, `members_synced_at=NOW()`.
  3. Respect rate limits:
     - Concurrency controls (e.g., p-limit 5–10) and small delays between Slack API pages.
     - Retry with backoff on `rate_limited` and transient errors.
  4. Idempotence:
     - `UPSERT` on `channel_id`.
     - Optional: skip summarization if `summary_updated_at` < X days and message count change < Y%.

- Execution:
  - Add script: `npm run channel-summaries` → `ts-node src/jobs/channel-summaries.ts`.
  - Manual trigger first; later wiring into admin actions or scheduler if desired.

---

### Implementation Steps

1. Database

   - Add SQL to `database/schema.sql` (or a new migration under `scripts/`) for:
     - `slack_export`, `slack_channel_export`, `slack_message` (align with existing insert logic).
     - `slack_channel_profiles` with trigger to maintain `updated_at`.
   - Re-run setup/migrations and backfill indexes.

2. Slack Manifest/Scopes

   - Update `slack-app-manifest.json` to include `conversations:read` in bot scopes.
   - Reinstall the app to grant the new scope.

3. Services

   - Add `ChannelSummarizerService` (or extend `src/lib/openai.ts`) with a method `summarizeChannel(messages: string[]): Promise<string>` using chat completions.
   - Add `ChannelService` to wrap Slack `conversations.members` with pagination + filtering.

4. Job

   - Implement `src/jobs/channel-summaries.ts` to:
     - Read channels from DB → load messages → summarize → fetch members → upsert profile.
     - Handle batching, pagination, retries, and logging.
   - Add `"channel-summaries": "ts-node src/jobs/channel-summaries.ts"` to `package.json` scripts.

5. Admin/Observability (optional but recommended)

   - Add admin action to trigger a refresh and DM the admin a short report (channels processed, skipped, errors).
   - Store minimal run metadata in `metadata` JSONB (e.g., message window used, token counts) for debugging.

6. Backfill & Rollout
   - One-time backfill: run the job over all channels from `slack_message`.
   - If private channels are required, invite the bot or scope accordingly; otherwise proceed with public channels only.
   - Schedule periodic refresh (e.g., weekly) once stable.

---

### Edge Cases & Considerations

- Channels with very few messages: generate a conservative summary (“This channel has minimal activity; intended for …” if purpose is available). Otherwise skip until threshold met.
- Very large channels: sample messages (time-stratified) to avoid bias toward latest chatter.
- Rate limiting: protect both Slack and OpenAI calls; exponential backoff.
- Multi-tenant: if/when OAuth is enabled, include `team_id` resolution and filter per tenant.
- Privacy: only process channels your bot can access; avoid leaking private-channel info.

---

### Acceptance Criteria

- A command `npm run channel-summaries` completes successfully and populates `slack_channel_profiles` with:
  - Non-empty 3-sentence summaries for each channel with messages in DB.
  - `member_ids` populated for channels the bot can access; `members_synced_at` updated.
- Re-running the command updates existing rows (UPSERT) without duplicates.
- Slack app has required scopes; errors due to missing membership access are logged and skipped gracefully.

---

### Follow-ons (nice-to-have)

- Store `purpose`/`topic` from `conversations.info` and use it as summarization context.
- Surface summaries in App Home or a slash command.
- Add embeddings for channel summaries to enable channel recommendation/search.
