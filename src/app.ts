import { App, ExpressReceiver } from "@slack/bolt";
import { config } from "dotenv";
import { db } from "./lib/database";
import { embeddingService } from "./lib/openai";
import { helperMatchingService, HelperSkill } from "./services/matching";
import { errorHandler } from "./utils/errorHandler";
import { sendWeeklyPrompts } from "./jobs/weekly-prompt";
import { UserService } from "./services/users";
import { oauthService } from "./services/oauth";

config();

// Create receiver - use ExpressReceiver for OAuth support
let receiver: ExpressReceiver | undefined;

if (process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET) {
  receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    installationStore: {
      storeInstallation: async (installation) => {
        // This will be handled by our OAuth service
        return;
      },
      fetchInstallation: async (query) => {
        // This will be handled by our OAuth service
        throw new Error("Use OAuth service for installation management");
      },
    },
  });

  // Health endpoint
  receiver.router.get("/health", async (req, res) => {
    console.log("🏥 Health check endpoint hit");
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      message: "Server is running",
    });
  });

  // OAuth install endpoint
  receiver.router.get("/slack/install", async (req, res) => {
    try {
      const installUrl = oauthService.generateInstallUrl();
      res.redirect(installUrl);
    } catch (error) {
      console.error("❌ Failed to generate install URL:", error);
      res.status(500).send("Failed to generate install URL");
    }
  });

  // OAuth callback handler
  receiver.router.get("/slack/oauth_redirect", async (req, res) => {
    const code = req.query.code as string;
    const state = req.query.state as string;

    if (!code) {
      res.status(400).send("Authorization code missing");
      return;
    }

    try {
      const installation = await oauthService.handleCallback(code, state);

      res.status(200).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Installation Successful</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px; max-width: 600px; margin: 0 auto; }
              .success { color: #28a745; }
              .code { background: #f8f9fa; padding: 15px; border-radius: 8px; margin: 10px 0; font-family: monospace; }
              .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 8px; margin: 15px 0; }
            </style>
          </head>
          <body>
            <h1 class="success">✅ Installation Successful!</h1>
            <p>The <strong>Offers and Asks</strong> app has been successfully installed to <strong>${installation.team?.name}</strong>.</p>
            
            <div class="warning">
              <strong>🎉 You're all set!</strong> The app is now ready to use in your workspace.
              <br><br>
              Try messaging the bot directly or visiting the App Home to get started.
            </div>
            
            <p><small>You can now close this window.</small></p>
          </body>
        </html>
      `);
    } catch (error) {
      console.error("❌ OAuth callback failed:", error);
      res.status(500).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Installation Failed</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px; max-width: 600px; margin: 0 auto; }
              .error { color: #dc3545; }
            </style>
          </head>
          <body>
            <h1 class="error">❌ Installation Failed</h1>
            <p>There was an error installing the app. Please try again or contact support.</p>
            <p><small>Error: ${
              error instanceof Error ? error.message : "Unknown error"
            }</small></p>
          </body>
        </html>
      `);
    }
  });

  console.log("📱 OAuth endpoints enabled:");
  console.log("   Install: /slack/install");
  console.log("   Callback: /slack/oauth_redirect");

  // External endpoint to accept Slack-like message JSON with bearer token auth
  receiver.router.post("/external/slack-message", async (req, res) => {
    try {
      const configuredToken =
        process.env.EXTERNAL_POST_BEARER_TOKEN || process.env.BEARER_TOKEN;

      if (!configuredToken) {
        console.warn(
          "⚠️ EXTERNAL_POST_BEARER_TOKEN (or BEARER_TOKEN) not set; rejecting external message"
        );
        res.status(503).json({
          ok: false,
          error: "endpoint_not_configured",
          message:
            "Server missing EXTERNAL_POST_BEARER_TOKEN; ask the admin to set it.",
        });
        return;
      }

      const authorizationHeader = req.headers["authorization"] as
        | string
        | undefined;
      const presentedToken = authorizationHeader?.startsWith("Bearer ")
        ? authorizationHeader.substring("Bearer ".length)
        : undefined;

      if (!presentedToken || presentedToken !== configuredToken) {
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
      }

      if (!req.is("application/json")) {
        res.status(415).json({
          ok: false,
          error: "unsupported_media_type",
          message: 'Content-Type must be "application/json"',
        });
        return;
      }

      const payload = req.body as any;
      if (!payload || typeof payload !== "object") {
        res.status(400).json({ ok: false, error: "invalid_json" });
        return;
      }

      // Log a concise summary to avoid noisy logs
      console.log("📨 Received external Slack message payload", {
        hasText: typeof payload.text === "string",
        hasChannel: typeof payload.channel === "string",
        keys: Object.keys(payload).slice(0, 10),
      });

      // If the payload matches the SlackExport schema, persist to DB
      const isSlackExportShape =
        typeof payload.collection_time === "string" &&
        payload.channels &&
        typeof payload.channels === "object" &&
        !Array.isArray(payload.channels);

      let persistedExportId: number | undefined;
      let persistSummary:
        | {
            channelsProcessed: number;
            messagesInserted: number;
            repliesInserted: number;
            duplicatesSkipped: number;
            channelsWithMissingId: number;
          }
        | undefined;
      if (isSlackExportShape) {
        try {
          const { exportId } = await db.runInTransaction(async (client) => {
            // 1) Top-level export record
            const exportInsert = await client.query(
              `INSERT INTO slack_export (collection_time, raw) VALUES ($1, $2::jsonb) RETURNING id`,
              [payload.collection_time || null, JSON.stringify(payload)]
            );
            const exportId: number = exportInsert.rows[0].id;

            // 2) Channel metadata and 3) messages
            const channels: Record<string, any> = payload.channels;
            let channelsProcessed = 0;
            let messagesInserted = 0;
            let repliesInserted = 0;
            let duplicatesSkipped = 0;
            let channelsWithMissingId = 0;
            for (const [channelName, channelData] of Object.entries(channels)) {
              const channelId: string | null = channelData?.id || null;
              const messageCount: number | null =
                channelData?.message_count ?? null;
              const threadRepliesCount: number | null =
                channelData?.thread_replies_count ?? null;

              const channelInsert = await client.query(
                `INSERT INTO slack_channel_export (export_id, channel_id, channel_name, message_count, thread_replies_count)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (export_id, channel_id) DO UPDATE SET
                   channel_name = EXCLUDED.channel_name,
                   message_count = EXCLUDED.message_count,
                   thread_replies_count = EXCLUDED.thread_replies_count
                 RETURNING id`,
                [
                  exportId,
                  channelId,
                  channelName,
                  messageCount,
                  threadRepliesCount,
                ]
              );
              const channelExportId: number = channelInsert.rows[0].id;
              channelsProcessed += 1;

              const messages: any[] = Array.isArray(channelData?.messages)
                ? channelData.messages
                : [];

              if (!channelId) {
                channelsWithMissingId += 1;
                if (messages.length > 0) {
                  console.warn(
                    `⚠️ Skipping message inserts for channel "${channelName}" because channel_id is missing`
                  );
                }
              }

              const insertMessage = async (
                msg: any,
                isReply: boolean,
                parentTs: string | null
              ) => {
                const ts: string = String(msg.timestamp);
                const userId: string | null = msg.user ?? null;
                const text: string | null = msg.text ?? null;
                const messageType: string | null = msg.type ?? null;
                const subtype: string | null = msg.subtype ?? null;
                const threadTs: string | null = msg.thread_ts ?? null;
                if (!channelId) {
                  return false;
                }
                const result = await client.query(
                  `INSERT INTO slack_message (
                    export_id,
                    channel_export_id,
                    channel_id,
                    channel_name,
                    ts,
                    user_id,
                    text,
                    message_type,
                    subtype,
                    thread_ts,
                    is_reply,
                    parent_ts,
                    raw
                  ) VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb
                  ) ON CONFLICT (channel_id, ts) DO NOTHING`,
                  [
                    exportId,
                    channelExportId,
                    channelId,
                    channelName,
                    ts,
                    userId,
                    text,
                    messageType,
                    subtype,
                    threadTs,
                    isReply,
                    parentTs,
                    JSON.stringify(msg),
                  ]
                );
                return result.rowCount === 1;
              };

              for (const msg of messages) {
                const inserted = await insertMessage(msg, false, null);
                if (inserted) {
                  messagesInserted += 1;
                } else {
                  duplicatesSkipped += 1; // either duplicate or missing channel id
                }
                const replies: any[] = Array.isArray(msg.replies)
                  ? msg.replies
                  : [];
                for (const reply of replies) {
                  const rInserted = await insertMessage(
                    reply,
                    true,
                    String(msg.timestamp)
                  );
                  if (rInserted) {
                    repliesInserted += 1;
                  } else {
                    duplicatesSkipped += 1;
                  }
                }
              }
            }

            persistSummary = {
              channelsProcessed,
              messagesInserted,
              repliesInserted,
              duplicatesSkipped,
              channelsWithMissingId,
            };
            return { exportId };
          });
          persistedExportId = exportId;
        } catch (dbError) {
          console.error("❌ Failed to persist SlackExport:", dbError);
          await errorHandler.handle(dbError, "persist_slack_export");
          res.status(500).json({ ok: false, error: "db_persist_failed" });
          return;
        }
      }

      // Optionally forward to Slack if channel + text (or blocks) are provided
      const channel: string | undefined = payload.channel;
      const text: string | undefined = payload.text;
      const blocks: any[] | undefined = payload.blocks;
      const threadTs: string | undefined =
        payload.thread_ts || payload.threadTs;

      let posted = false;
      let postResponse: any = undefined;

      if (channel && (text || blocks)) {
        // Resolve bot token: prefer team from payload/header, fallback to env
        const teamId: string | undefined =
          payload.teamId ||
          payload.team_id ||
          payload.team?.id ||
          (req.headers["x-slack-team-id"] as string | undefined);

        let botToken: string | null | undefined = undefined;
        if (teamId) {
          try {
            botToken = await oauthService.getBotToken(teamId);
          } catch (e) {
            console.warn("⚠️ Failed to fetch bot token for team:", teamId, e);
          }
        }
        if (!botToken) {
          botToken = process.env.SLACK_BOT_TOKEN || null;
        }

        if (!botToken) {
          res.status(503).json({
            ok: false,
            error: "no_bot_token_available",
            message:
              "No bot token available. Provide teamId for an installed workspace or set SLACK_BOT_TOKEN.",
          });
          return;
        }

        try {
          postResponse = await app.client.chat.postMessage({
            token: botToken,
            channel,
            text: text || undefined,
            blocks: (blocks as any) || undefined,
            thread_ts: threadTs || undefined,
          });
          posted = Boolean(postResponse?.ok);
        } catch (e) {
          console.error("❌ chat.postMessage failed:", e);
          res.status(502).json({ ok: false, error: "slack_post_failed" });
          return;
        }
      }

      res.status(200).json({
        ok: true,
        status: "accepted",
        posted,
        slack: postResponse,
        export_id: persistedExportId,
        persist: persistSummary,
      });
    } catch (err) {
      console.error("❌ External slack-message handler failed:", err);
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });
  console.log(
    "🔐 External endpoint enabled: POST /external/slack-message (Bearer auth)"
  );
}

// Validate required environment variables
if (!process.env.SLACK_SIGNING_SECRET) {
  throw new Error(
    "Required environment variable SLACK_SIGNING_SECRET is not set"
  );
}

// Check if we have OAuth credentials OR bot token
// TEMPORARY: Force single-workspace mode to fix DM issue
const hasOAuth = false; // process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET;
const hasBotToken = process.env.SLACK_BOT_TOKEN;

if (!hasOAuth && !hasBotToken) {
  console.error("❌ Missing Slack credentials. You need either:");
  console.error(
    "   1. OAuth: SLACK_CLIENT_ID + SLACK_CLIENT_SECRET (for multi-workspace)"
  );
  console.error("   2. Bot Token: SLACK_BOT_TOKEN (for single workspace)");
  process.exit(1);
}

// Create app with or without OAuth receiver
console.log("🔧 App setup:", {
  hasReceiver: !!receiver,
  hasOAuth: hasOAuth,
  hasBotToken: hasBotToken,
  socketMode: false,
});

export const app = receiver
  ? new App({
      receiver,
      authorize: async ({ teamId }) => {
        console.log("🔐 OAuth authorize called for team:", teamId);

        // Try to get token from OAuth service first
        if (teamId) {
          const token = await oauthService.getBotToken(teamId);
          if (token) {
            console.log("✅ Found OAuth bot token for team:", teamId);
            return { botToken: token };
          }
          console.log("⚠️ No OAuth token found for team:", teamId);
        }

        // Fallback to env token for single workspace mode
        if (process.env.SLACK_BOT_TOKEN) {
          console.log("✅ Using fallback env bot token for team:", teamId);
          return { botToken: process.env.SLACK_BOT_TOKEN };
        }

        console.error(
          `❌ No token available for team ${teamId} - neither OAuth nor env token found`
        );
        throw new Error(`No token found for team ${teamId}`);
      },
    })
  : new App({
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
      token: process.env.SLACK_BOT_TOKEN!,
      socketMode: false,
    });

console.log("✅ Slack App created successfully");

// Get bot user ID to prevent infinite loops
let botUserId: string | null = null;
let botTeamId: string | null = null;
let botTeamName: string | null = null;

// Lightweight cache for user display names to enrich logs without spamming Slack API
const userNameCache = new Map<
  string,
  { realName: string; displayName: string; updatedAt: number }
>();
const USER_NAME_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getUserNames(
  client: any,
  userId: string
): Promise<{ realName: string; displayName: string }> {
  const cached = userNameCache.get(userId);
  const now = Date.now();
  if (cached && now - cached.updatedAt < USER_NAME_CACHE_TTL_MS) {
    return { realName: cached.realName, displayName: cached.displayName };
  }
  try {
    const info = await client.users.info({ user: userId });
    const realName = info.user?.real_name || info.user?.name || "Unknown";
    const displayName = info.user?.profile?.display_name || realName;
    userNameCache.set(userId, { realName, displayName, updatedAt: now });
    return { realName, displayName };
  } catch {
    return { realName: "Unknown", displayName: userId };
  }
}

// Rate limiting to prevent spam/loops (user -> last message timestamp)
const userMessageTimestamps = new Map<string, number>();
const MESSAGE_COOLDOWN_MS = 2000; // 2 seconds between messages per user
(async () => {
  try {
    const authTest = await app.client.auth.test();
    botUserId = authTest.user_id as string;
    botTeamId = (authTest as any).team_id || null;
    botTeamName = (authTest as any).team || null;
    console.log("🤖 Bot identity:", {
      botUserId,
      botTeamId,
      botTeamName,
    });
  } catch (error) {
    console.error("❌ Failed to get bot user ID:", error);
  }
})();

// Helper function to check if user is admin
const isAdmin = (userId: string): boolean => {
  const adminIds = (process.env.ADMIN_USER_ID || "")
    .split(",")
    .map((id) => id.trim());
  return adminIds.includes(userId);
};

// Helper function to format helper results
const formatHelperResults = (helpers: any[], needText: string) => {
  if (helpers.length === 0) {
    return {
      text: "I couldn't find any helpers for your specific need right now.",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "🔍 I couldn't find any helpers for your specific need right now. Try rephrasing your request or check back later as more people add skills to their profiles.",
          },
        },
      ],
    };
  }

  // Build blocks for each helper
  const helperBlocks: any[] = [];

  helpers.slice(0, 5).forEach((helper) => {
    // Use slack_user_id for proper user mentions, fallback to name
    const userDisplay =
      helper.slack_user_id && helper.slack_user_id.startsWith("U")
        ? `<@${helper.slack_user_id}>`
        : helper.name;

    // Build Fellow details text
    const fellowDetails: string[] = [];
    if (helper.expertise) {
      fellowDetails.push(`*Expertise:* ${helper.expertise}`);
    }
    if (helper.projects) {
      fellowDetails.push(`*Projects:* ${helper.projects}`);
    }
    if (helper.offers) {
      fellowDetails.push(`*Offers:* ${helper.offers}`);
    }

    // Add main section with name and Fellow details
    helperBlocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${userDisplay}*${
          fellowDetails.length > 0 ? "\n" + fellowDetails.join("\n") : ""
        }`,
      },
    });

    // Add skills in context block if they have any
    if (helper.skills.length > 0) {
      const skillsText = helper.skills
        .slice(0, 3)
        .map((skillObj: HelperSkill) => {
          // Bold skills with >70% relevance
          if (skillObj.score > 0.7) {
            return `*${skillObj.skill}*`;
          } else {
            return skillObj.skill;
          }
        })
        .join(", ");

      helperBlocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Skills: ${skillsText}`,
          },
        ],
      });
    }

    // Add a small divider between helpers
    helperBlocks.push({
      type: "divider",
    });
  });

  return {
    text: `Found ${helpers.length} people who might help with: "${needText}"`,
    blocks: [
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🎯 *Found ${helpers.length} people who might help with:*\n_"${needText}"_`,
        },
      },
      {
        type: "divider",
      },
      ...helperBlocks,
    ],
  };
};

// App home opened event
app.event("app_home_opened", async ({ event, client }) => {
  try {
    const userId = event.user;
    console.log(`📱 App home opened by user: ${userId}`);

    // Ensure user exists in database
    const userInfo = await client.users.info({ user: userId });
    await db.createPerson(
      userId,
      userInfo.user?.real_name || userInfo.user?.name || "Unknown"
    );

    // Get user's skills
    const userSkills = await db.getPersonSkills(userId);
    console.log(`📱 User ${userId} has ${userSkills.length} skills`);

    // Build blocks for the home view
    const blocks: any[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Welcome to Offers and Asks! 🤝*\n\nConnect with teammates who have the skills you need, or help others with your expertise.",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: " ",
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: " ",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Your Skills*",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text:
              userSkills.length > 0
                ? `Skills: ${userSkills.map((s) => s.skill).join(", ")}`
                : 'No skills added yet. Click "Manage Skills" to add some!',
          },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Manage Skills",
            },
            action_id: "manage_skills",
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: " ",
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: " ",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Need Help?*",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "💡 You can also DM me directly with what you need help with!",
          },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Find Helpers",
            },
            action_id: "find_helpers",
            style: "primary",
          },
        ],
      },
    ];

    // Add admin section if user is admin
    if (isAdmin(userId)) {
      // Get weekly stats
      const stats = await helperMatchingService.getWeeklyStats();

      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: " ",
          },
        },
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: " ",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*🔧 Admin Controls*",
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `📊 Quick Stats: ${stats.totalHelpers} helpers • ${
                stats.totalNeeds
              } needs this week • Top skill: ${
                stats.topSkills[0]?.skill || "N/A"
              }`,
            },
          ],
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "📨 Send Weekly Prompts",
              },
              action_id: "admin_send_weekly",
              style: "primary",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "📊 View Stats",
              },
              action_id: "admin_view_stats",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "🧪 Test DM",
              },
              action_id: "admin_test_dm",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "👥 List Users",
              },
              action_id: "admin_list_users",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "🔄 Sync Users",
              },
              action_id: "admin_sync_users",
            },
          ],
        }
      );
    }

    console.log(`📱 Publishing home view with ${blocks.length} blocks`);

    const publishResult = await client.views.publish({
      user_id: userId,
      view: {
        type: "home",
        blocks,
      },
    });

    console.log(
      `📱 Home view published successfully for user ${userId}:`,
      publishResult.ok
    );
  } catch (error) {
    console.error(`❌ Error in app_home_opened for user ${event.user}:`, error);
    await errorHandler.handle(error, "app_home_opened", { userId: event.user });

    // Try to at least show a simple message if view publishing fails
    try {
      await client.views.publish({
        user_id: event.user,
        view: {
          type: "home",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "*Welcome to Offers and Asks! 🤝*\n\nDM me with what you need help with, and I'll find teammates with matching skills.\n\nExample: 'I need help with React testing'",
              },
            },
          ],
        },
      });
    } catch (fallbackError) {
      console.error(`❌ Even fallback view failed:`, fallbackError);
    }
  }
});

// Admin action: Send weekly prompts
app.action("admin_send_weekly", async ({ ack, body, client }) => {
  await ack();

  const userId = (body as any).user.id;
  if (!isAdmin(userId)) {
    return;
  }

  try {
    // Show loading message
    await client.chat.postMessage({
      channel: userId,
      text: "⏳ Sending weekly prompts to all enabled users...",
    });

    // Run the weekly prompt job
    await sendWeeklyPrompts();

    await client.chat.postMessage({
      channel: userId,
      text: "✅ Weekly prompts sent successfully!",
    });
  } catch (error) {
    await client.chat.postMessage({
      channel: userId,
      text: `❌ Failed to send weekly prompts: ${error}`,
    });
    await errorHandler.handle(error, "admin_send_weekly", { userId });
  }
});

// Admin action: View stats
app.action("admin_view_stats", async ({ ack, body, client }) => {
  await ack();

  const userId = (body as any).user.id;
  if (!isAdmin(userId)) {
    return;
  }

  try {
    const stats = await helperMatchingService.getWeeklyStats();
    const enabledUsers = await db.getAllEnabledPeople();

    const topSkillsText = stats.topSkills
      .slice(0, 10)
      .map((s, i) => `${i + 1}. ${s.skill} (${s.count} people)`)
      .join("\n");

    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: "modal",
        title: {
          type: "plain_text",
          text: "📊 System Statistics",
        },
        close: {
          type: "plain_text",
          text: "Close",
        },
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*📈 Overall Stats*",
            },
          },
          {
            type: "section",
            fields: [
              {
                type: "mrkdwn",
                text: `*Total Helpers:*\n${stats.totalHelpers}`,
              },
              {
                type: "mrkdwn",
                text: `*Enabled Users:*\n${enabledUsers.length}`,
              },
              {
                type: "mrkdwn",
                text: `*Needs This Week:*\n${stats.totalNeeds}`,
              },
              {
                type: "mrkdwn",
                text: `*Avg Match Score:*\n${stats.averageMatchScore.toFixed(
                  2
                )}`,
              },
            ],
          },
          {
            type: "divider",
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*🏆 Top Skills*\n${
                topSkillsText || "No skills data available"
              }`,
            },
          },
        ],
      },
    });
  } catch (error) {
    await errorHandler.handle(error, "admin_view_stats", { userId });
  }
});

// Admin action: Test DM
app.action("admin_test_dm", async ({ ack, body, client }) => {
  await ack();

  const userId = (body as any).user.id;
  if (!isAdmin(userId)) {
    return;
  }

  try {
    await client.chat.postMessage({
      channel: userId,
      text: "🧪 Test DM from Offers and Asks bot!",
      blocks: [
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: '🧪 *Test DM successful!*\n\nYou can send me messages like:\n• "I need help with React testing"\n• "Looking for someone who knows PostgreSQL"\n• "Need assistance with Docker deployment"',
          },
        },
      ],
    });
  } catch (error: any) {
    console.error(`Admin test DM failed for ${userId}:`, error.message);
    await errorHandler.handle(error, "admin_test_dm", { userId });
  }
});

// Admin action: List workspace users
app.action("admin_list_users", async ({ ack, body, client }) => {
  await ack();

  const userId = (body as any).user.id;
  if (!isAdmin(userId)) {
    return;
  }

  try {
    const userService = new UserService(client);
    const users = await userService.fetchAllUsers();
    const userList = userService.formatUserList(users);

    // Split user list into chunks if it's too long for a single message
    const chunks = userList.match(/(?:[^\n]+\n?){1,50}/g) || [];

    await client.chat.postMessage({
      channel: userId,
      text: `Found ${users.length} users in workspace`,
      blocks: [
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `👥 *Found ${users.length} users in workspace*\n\nFormat: *Real Name* (display_name) - \`slack_id\``,
          },
        },
      ],
    });

    // Send user list in chunks to avoid message size limits
    for (let i = 0; i < chunks.length; i++) {
      const isLastChunk = i === chunks.length - 1;
      const blocks: any[] = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: chunks[i].trim(),
          },
        },
      ];

      // Add context on last chunk
      if (isLastChunk) {
        blocks.push({
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Use the "Sync Users" button to add all users to the database`,
            },
          ],
        });
      }

      await client.chat.postMessage({
        channel: userId,
        text: `Users ${i * 50 + 1}-${Math.min((i + 1) * 50, users.length)}`,
        blocks,
      });
    }
  } catch (error: any) {
    console.error(`Admin list users failed for ${userId}:`, error.message);
    await errorHandler.handle(error, "admin_list_users", { userId });
  }
});

// Admin action: Sync workspace users to database
app.action("admin_sync_users", async ({ ack, body, client }) => {
  await ack();

  const userId = (body as any).user.id;
  if (!isAdmin(userId)) {
    return;
  }

  try {
    await client.chat.postMessage({
      channel: userId,
      text: "Starting user sync...",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "🔄 *Starting user sync...*\n\nThis may take a moment.",
          },
        },
      ],
    });

    const userService = new UserService(client);
    const { added, updated } = await userService.syncUsersToDatabase();

    await client.chat.postMessage({
      channel: userId,
      text: `User sync complete: ${added} added, ${updated} updated`,
      blocks: [
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `✅ *User sync complete!*\n\n• *Added:* ${added} users\n• *Updated:* ${updated} users`,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "All workspace users have been synced to the database",
            },
          ],
        },
      ],
    });
  } catch (error: any) {
    console.error(`Admin sync users failed for ${userId}:`, error.message);
    await errorHandler.handle(error, "admin_sync_users", { userId });

    await client.chat.postMessage({
      channel: userId,
      text: "❌ User sync failed. Check logs for details.",
    });
  }
});

// Handle direct messages - process needs and reply in thread
console.log("🚀 Registering DM message handler...");
app.message(async ({ message, client, say }) => {
  console.log("💬 MESSAGE HANDLER TRIGGERED!", {
    teamId: botTeamId,
    teamName: botTeamName,
  });
  try {
    console.log("📨 Received message:", {
      channel_type: (message as any).channel_type,
      subtype: (message as any).subtype,
      user: (message as any).user,
      bot_id: (message as any).bot_id,
      text: (message as any).text?.substring(0, 50),
      channel: (message as any).channel,
      teamId: botTeamId,
      teamName: botTeamName,
    });

    // Comprehensive bot message filtering to prevent infinite loops
    const channelType = (message as any).channel_type;
    const channel = (message as any).channel;
    const subtype = (message as any).subtype;
    const user = (message as any).user;
    const botId = (message as any).bot_id;

    // Check if this is a DM
    const isDM = channelType === "im" || (channel && channel.startsWith("D"));
    if (!isDM) {
      console.log("📨 Skipping - not a DM channel:", { channelType, channel });
      return;
    }

    // Filter out ALL bot messages to prevent infinite loops
    const isFromThisBot = botUserId && user === botUserId;
    const isFromAnyBot =
      !!botId ||
      subtype === "bot_message" ||
      (message as any).app_id ||
      (message as any).bot_profile;
    const isSystemMessage =
      subtype === "message_changed" ||
      subtype === "message_deleted" ||
      subtype === "channel_join" ||
      subtype === "channel_leave" ||
      subtype === "file_share" ||
      subtype === "thread_broadcast";
    const hasNoUser = !user; // System messages often have no user

    if (isFromThisBot || isFromAnyBot || isSystemMessage || hasNoUser) {
      console.log("📨 Skipping bot/system message:", {
        isFromThisBot,
        isFromAnyBot,
        isSystemMessage,
        hasNoUser,
        user,
        botId,
        subtype,
        botUserId,
        textPreview: (message as any).text?.substring(0, 50),
      });
      return;
    }

    const userId = user; // Use the already extracted user
    const messageText = (message as any).text;
    const ts = (message as any).ts;

    // Additional safety checks
    if (!userId || !messageText || !ts) {
      console.log("📨 Skipping - missing required fields:", {
        userId: !!userId,
        messageText: !!messageText,
        ts: !!ts,
      });
      return;
    }

    // Resolve user names for richer logging
    const { realName, displayName } = await getUserNames(client, userId);

    // Rate limiting check to prevent spam/loops
    const now = Date.now();
    const lastMessageTime = userMessageTimestamps.get(userId) || 0;
    if (now - lastMessageTime < MESSAGE_COOLDOWN_MS) {
      console.log("📨 Skipping - rate limited:", {
        userId,
        cooldownMs: now - lastMessageTime,
        nextAllowedInMs: MESSAGE_COOLDOWN_MS - (now - lastMessageTime),
        teamId: botTeamId,
      });
      return;
    }
    userMessageTimestamps.set(userId, now);

    // Skip if message is too short or looks like a command/system message
    if (
      messageText.length < 3 ||
      messageText.startsWith("/") ||
      messageText.startsWith("!")
    ) {
      await say({
        thread_ts: ts,
        text: "Please describe what you need help with in more detail. For example: 'I need help setting up React testing with Jest'",
      });
      return;
    }

    // We've passed all filters - this is a legitimate user message to process
    console.log("✅ Processing legitimate user message:", {
      userId,
      userName: realName,
      displayName,
      channel,
      threadTs: ts,
      messageChars: messageText.length,
      messagePreview: messageText.substring(0, 100),
      teamId: botTeamId,
    });

    // Check for commands
    if (
      messageText.toLowerCase().includes("/help") ||
      messageText.toLowerCase() === "help"
    ) {
      await say({
        thread_ts: ts,
        text: "Here's how to use me:",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*How to use Offers and Asks:*\n\n• Send me a message describing what you need help with\n• I'll find teammates with matching skills\n• Visit the app home to manage your skills\n\n*Example messages:*\n• 'I need help with React testing'\n• 'Looking for PostgreSQL optimization tips'\n• 'Need someone who knows Kubernetes'",
            },
          },
        ],
      });
      return;
    }

    // Send thinking message
    const thinkingMsg = await client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: "🔍 Looking for helpers...",
    });
    console.log("🧵 Posted thinking message:", {
      channel,
      threadTs: ts,
      messageTs: (thinkingMsg as any).ts,
    });

    try {
      // Find helpers for this need
      const helpers = await helperMatchingService.findHelpers(
        messageText,
        userId
      );

      // Format and send results
      const results = formatHelperResults(helpers, messageText);

      // Update the thinking message with results
      await client.chat.update({
        channel,
        ts: thinkingMsg.ts!,
        ...results,
      });
      console.log("📤 Results posted:", {
        channel,
        updatedTs: thinkingMsg.ts,
        helpersReturned: helpers.length,
        topHelperNames: helpers.slice(0, 3).map((h) => h.name),
      });

      // Weekly need is stored within HelperMatchingService to avoid duplication
    } catch (error) {
      // Update thinking message with error
      await client.chat.update({
        channel,
        ts: thinkingMsg.ts!,
        text: "❌ Sorry, I encountered an error while looking for helpers. Please try again or visit the app home.",
      });
      throw error;
    }
  } catch (error) {
    await errorHandler.handle(error, "message_handler", {
      channel: (message as any).channel,
      user: (message as any).user,
    });
  }
});

// Handle "Find Helpers" button
app.action("find_helpers", async ({ ack, body, client }) => {
  await ack();

  try {
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: "modal",
        callback_id: "need_help_modal",
        title: {
          type: "plain_text",
          text: "What do you need?",
        },
        submit: {
          type: "plain_text",
          text: "Find Helpers",
        },
        close: {
          type: "plain_text",
          text: "Cancel",
        },
        blocks: [
          {
            type: "input",
            block_id: "need_input",
            element: {
              type: "plain_text_input",
              action_id: "need_text",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: 'Describe what you need help with... (e.g., "Setting up React testing with Jest", "Optimizing PostgreSQL queries")',
              },
            },
            label: {
              type: "plain_text",
              text: "Your need",
            },
          },
        ],
      },
    });
  } catch (error) {
    await errorHandler.handle(error, "find_helpers", {
      userId: (body as any).user.id,
    });
  }
});

// Handle "Need Help?" button from weekly DM
app.action("open_need_modal", async ({ ack, body, client }) => {
  await ack();

  try {
    // Reuse the same modal as find_helpers
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: "modal",
        callback_id: "need_help_modal",
        title: {
          type: "plain_text",
          text: "What do you need?",
        },
        submit: {
          type: "plain_text",
          text: "Find Helpers",
        },
        close: {
          type: "plain_text",
          text: "Cancel",
        },
        blocks: [
          {
            type: "input",
            block_id: "need_input",
            element: {
              type: "plain_text_input",
              action_id: "need_text",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: 'Describe what you need help with... (e.g., "Setting up React testing with Jest", "Optimizing PostgreSQL queries")',
              },
            },
            label: {
              type: "plain_text",
              text: "Your need",
            },
          },
        ],
      },
    });
  } catch (error) {
    await errorHandler.handle(error, "open_need_modal", {
      userId: (body as any).user.id,
    });
  }
});

// Handle "Manage Skills" button
app.action("manage_skills", async ({ ack, body, client }) => {
  await ack();

  try {
    const userId = (body as any).user.id;
    const userSkills = await db.getPersonSkills(userId);

    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: "modal",
        callback_id: "manage_skills_modal",
        title: {
          type: "plain_text",
          text: "Manage Your Skills",
        },
        submit: {
          type: "plain_text",
          text: "Save",
        },
        close: {
          type: "plain_text",
          text: "Cancel",
        },
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Current Skills:*",
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text:
                  userSkills.length > 0
                    ? userSkills.map((s) => `• ${s.skill}`).join("\n")
                    : "No skills added yet.",
              },
            ],
          },
          {
            type: "divider",
          },
          {
            type: "input",
            block_id: "skills_input",
            element: {
              type: "plain_text_input",
              action_id: "skills_text",
              placeholder: {
                type: "plain_text",
                text: "React, Node.js, PostgreSQL, Machine Learning",
              },
            },
            label: {
              type: "plain_text",
              text: "Add new skills (comma-separated)",
            },
            optional: true,
          },
          {
            type: "input",
            block_id: "remove_skills",
            element: {
              type: "plain_text_input",
              action_id: "remove_text",
              placeholder: {
                type: "plain_text",
                text: "Enter skills to remove, comma-separated",
              },
            },
            label: {
              type: "plain_text",
              text: "Remove skills (optional)",
            },
            optional: true,
          },
        ],
      },
    });
  } catch (error) {
    await errorHandler.handle(error, "manage_skills", {
      userId: (body as any).user.id,
    });
  }
});

// Handle need help modal submission
app.view("need_help_modal", async ({ ack, body, view, client }) => {
  await ack();

  try {
    const userId = body.user.id;
    const needText = view.state.values.need_input?.need_text?.value;

    if (!needText) {
      return;
    }

    // Find helpers for this need
    const helpers = await helperMatchingService.findHelpers(needText, userId);

    // Format and send results directly to user (using user ID as channel)
    const results = formatHelperResults(helpers, needText);
    await client.chat.postMessage({
      channel: userId,
      ...results,
    });
  } catch (error) {
    await errorHandler.handle(error, "need_help_modal", {
      userId: body.user.id,
    });
  }
});

// Handle skills modal submission
app.view("manage_skills_modal", async ({ ack, body, view, client }) => {
  await ack();

  try {
    const userId = body.user.id;
    const addSkillsText = view.state.values.skills_input?.skills_text?.value;
    const removeSkillsText =
      view.state.values.remove_skills?.remove_text?.value;

    const addedSkills = [];
    const removedSkills = [];

    // Add new skills
    if (addSkillsText) {
      const newSkills = addSkillsText
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const skill of newSkills) {
        let skillRecord = await db.getSkillByText(skill);
        if (!skillRecord) {
          const skillId = await db.createSkill(skill);
          const embedding = await embeddingService.generateEmbedding(skill);
          await db.updateSkillEmbedding(skillId, embedding);
          skillRecord = { id: skillId, skill };
        }

        await db.addPersonSkill(userId, skillRecord.id);
        addedSkills.push(skill);
      }
    }

    // Remove skills
    if (removeSkillsText) {
      const skillsToRemove = removeSkillsText
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const skill of skillsToRemove) {
        const skillRecord = await db.getSkillByText(skill);
        if (skillRecord) {
          await db.removePersonSkill(userId, skillRecord.id);
          removedSkills.push(skill);
        }
      }
    }

    // Skills updated - home page refresh will show the changes, no need for DM confirmation

    // Refresh the app home to show updated skills
    try {
      // Get updated user skills
      const updatedUserSkills = await db.getPersonSkills(userId);

      // Build blocks for the home view (same logic as app_home_opened)
      const blocks: any[] = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Welcome to Offers and Asks! 🤝*\n\nConnect with teammates who have the skills you need, or help others with your expertise.",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: " ",
          },
        },
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: " ",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Your Skills*",
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text:
                updatedUserSkills.length > 0
                  ? `Skills: ${updatedUserSkills
                      .map((s) => s.skill)
                      .join(", ")}`
                  : 'No skills added yet. Click "Manage Skills" to add some!',
            },
          ],
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Manage Skills",
              },
              action_id: "manage_skills",
            },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: " ",
          },
        },
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: " ",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Need Help?*",
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "💡 You can also DM me directly with what you need help with!",
            },
          ],
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Find Helpers",
              },
              action_id: "find_helpers",
              style: "primary",
            },
          ],
        },
      ];

      // Add admin section if user is admin
      if (isAdmin(userId)) {
        const stats = await helperMatchingService.getWeeklyStats();
        blocks.push(
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: " ",
            },
          },
          {
            type: "divider",
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: " ",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*🔧 Admin Controls*",
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `📊 Quick Stats: ${stats.totalHelpers} helpers • ${
                  stats.totalNeeds
                } needs this week • Top skill: ${
                  stats.topSkills[0]?.skill || "N/A"
                }`,
              },
            ],
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "📨 Send Weekly Prompts",
                },
                action_id: "admin_send_weekly",
                style: "primary",
              },
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "📊 View Stats",
                },
                action_id: "admin_view_stats",
              },
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "🧪 Test DM",
                },
                action_id: "admin_test_dm",
              },
            ],
          }
        );
      }

      // Refresh the home view
      await client.views.publish({
        user_id: userId,
        view: {
          type: "home",
          blocks,
        },
      });

      console.log(
        `📱 Home view refreshed for user ${userId} after skills update`
      );
    } catch (homeRefreshError: any) {
      console.warn(
        `Could not refresh home view for ${userId}:`,
        homeRefreshError.message
      );
      // Don't fail the whole operation if home refresh fails
    }
  } catch (error) {
    await errorHandler.handle(error, "manage_skills_modal", {
      userId: body.user.id,
    });
  }
});

// Add comprehensive event logging to debug what events are being received
app.event(/.+/, async ({ event, client }) => {
  console.log("🔍 RECEIVED EVENT:", {
    type: event.type,
    user: (event as any).user,
    channel: (event as any).channel,
    channel_type: (event as any).channel_type,
    subtype: (event as any).subtype,
    text: (event as any).text?.substring(0, 50),
    timestamp: new Date().toISOString(),
  });
});

// Add middleware to log all incoming requests
if (receiver) {
  receiver.router.use((req, res, next) => {
    console.log("🌐 INCOMING REQUEST:", {
      method: req.method,
      url: req.url,
      headers: {
        "x-slack-signature": req.headers["x-slack-signature"]
          ? "present"
          : "missing",
        "x-slack-request-timestamp": req.headers["x-slack-request-timestamp"]
          ? "present"
          : "missing",
        "content-type": req.headers["content-type"],
      },
      userAgent: req.headers["user-agent"]?.substring(0, 50),
    });

    // Specifically log Slack webhook events
    if (req.url === "/slack/events" && req.method === "POST") {
      console.log("🎯 SLACK EVENT WEBHOOK HIT!");

      // Log body for Slack events (be careful with size)
      if (req.body) {
        console.log("📦 Event body type:", req.body.type);
        console.log("📦 Event:", req.body.event?.type);
      }
    }

    next();
  });
}

// Error handling for unhandled events
app.error(async (error) => {
  console.error("Slack app error:", error);
  await errorHandler.handle(error, "slack_app_error");
});

export default app;
