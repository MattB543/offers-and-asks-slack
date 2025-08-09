import { config } from "dotenv";
import { db } from "../lib/database";
import { channelSummarizerService } from "../lib/openai";
import { WebClient } from "@slack/web-api";
import { oauthService } from "../services/oauth";

config();

type ChannelRow = { channel_id: string; channel_name: string | null };

async function getDistinctChannels(): Promise<ChannelRow[]> {
  const result = await db.query(
    `SELECT channel_id, MAX(channel_name) AS channel_name
     FROM slack_message
     WHERE channel_id IS NOT NULL
     GROUP BY channel_id
     ORDER BY channel_id`
  );
  return result.rows as ChannelRow[];
}

async function getRecentMessages(
  channelId: string,
  limit: number = 100
): Promise<string[]> {
  const result = await db.query(
    `SELECT text
     FROM slack_message
     WHERE channel_id = $1 AND text IS NOT NULL
     ORDER BY ts DESC
     LIMIT $2`,
    [channelId, limit]
  );
  return result.rows.map((r: any) => r.text as string);
}

async function upsertChannelProfile(params: {
  channel_id: string;
  channel_name: string | null;
  team_id: string | null;
  summary: string | null;
  summary_model: string | null;
  member_ids: string[] | null;
  set_summary_ts: boolean;
  set_members_ts: boolean;
  metadata?: any;
}) {
  const {
    channel_id,
    channel_name,
    team_id,
    summary,
    summary_model,
    member_ids,
    set_summary_ts,
    set_members_ts,
    metadata,
  } = params;

  await db.query(
    `INSERT INTO slack_channel_profiles (
       channel_id, channel_name, team_id, summary, summary_model, summary_updated_at,
       member_ids, members_synced_at, metadata
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9::jsonb
     )
     ON CONFLICT (channel_id) DO UPDATE SET
       channel_name = COALESCE(EXCLUDED.channel_name, slack_channel_profiles.channel_name),
       team_id = COALESCE(EXCLUDED.team_id, slack_channel_profiles.team_id),
       summary = COALESCE(EXCLUDED.summary, slack_channel_profiles.summary),
       summary_model = COALESCE(EXCLUDED.summary_model, slack_channel_profiles.summary_model),
       summary_updated_at = COALESCE(EXCLUDED.summary_updated_at, slack_channel_profiles.summary_updated_at),
       member_ids = COALESCE(EXCLUDED.member_ids, slack_channel_profiles.member_ids),
       members_synced_at = COALESCE(EXCLUDED.members_synced_at, slack_channel_profiles.members_synced_at),
       metadata = COALESCE(EXCLUDED.metadata, slack_channel_profiles.metadata)
    `,
    [
      channel_id,
      channel_name,
      team_id,
      summary,
      summary_model,
      set_summary_ts ? new Date().toISOString() : null,
      member_ids,
      set_members_ts ? new Date().toISOString() : null,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
}

async function resolveSlackClient(): Promise<WebClient | null> {
  // Prefer single-workspace env token; fallback to first active tenant if available
  if (process.env.SLACK_BOT_TOKEN) {
    return new WebClient(process.env.SLACK_BOT_TOKEN);
  }
  // Pick any active tenant for now (single-tenant default)
  const result = await db.query(
    `SELECT team_id FROM tenants WHERE active = TRUE ORDER BY installed_at DESC LIMIT 1`
  );
  const teamId: string | undefined = result.rows[0]?.team_id;
  if (teamId) {
    const token = await oauthService.getBotToken(teamId);
    if (token) return new WebClient(token);
  }
  console.warn("⚠️ No Slack bot token available - skipping member sync");
  return null;
}

async function fetchChannelMembers(
  client: WebClient | null,
  channelId: string
): Promise<string[]> {
  if (!client) return [];
  const members: string[] = [];
  let cursor: string | undefined;
  do {
    const resp = await client.conversations.members({
      channel: channelId,
      cursor,
      limit: 1000,
    });
    if (Array.isArray(resp.members))
      members.push(...(resp.members as string[]));
    cursor = resp.response_metadata?.next_cursor;
    if (cursor) await new Promise((r) => setTimeout(r, 250));
  } while (cursor);
  return members;
}

export async function buildChannelSummaries(): Promise<void> {
  console.log("🚀 Channel summaries job starting...");
  const channels = await getDistinctChannels();
  console.log(`📚 Found ${channels.length} channels in slack_message`);

  const slackClient = await resolveSlackClient();
  const batchSize = 10;

  for (let i = 0; i < channels.length; i += batchSize) {
    const batch = channels.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (ch) => {
        try {
          // Load recent messages
          const messages = await getRecentMessages(ch.channel_id, 100);
          let summary: string | null = null;
          let summaryModel: string | null = null;
          if (messages.length >= 5) {
            const result = await channelSummarizerService.summarizeChannel(
              messages
            );
            summary = (result.summary || "").trim();
            summaryModel = result.model;
          } else {
            summary =
              "This channel has minimal recent activity; used for general discussion.";
            summaryModel = "template";
          }

          // Fetch members with pagination
          let members: string[] = [];
          try {
            members = await fetchChannelMembers(slackClient, ch.channel_id);
          } catch (e) {
            console.warn(`⚠️ Failed to fetch members for ${ch.channel_id}:`, e);
          }

          await upsertChannelProfile({
            channel_id: ch.channel_id,
            channel_name: ch.channel_name,
            team_id: null, // fill when multi-tenant resolution is added
            summary,
            summary_model: summaryModel,
            member_ids: members,
            set_summary_ts: true,
            set_members_ts: true,
            metadata: { messages_used: Math.min(messages.length, 100) },
          });

          console.log(
            `✅ Processed ${ch.channel_id} (${ch.channel_name || "unknown"})`
          );
          await new Promise((r) => setTimeout(r, 150));
        } catch (err) {
          console.error(`❌ Failed channel ${ch.channel_id}:`, err);
        }
      })
    );

    if (i + batchSize < channels.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log("🏁 Channel summaries job complete");
}

// Execute if run directly
if (require.main === module) {
  buildChannelSummaries()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Channel summaries job failed:", err);
      process.exit(1);
    });
}
