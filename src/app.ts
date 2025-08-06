import { App, ExpressReceiver } from "@slack/bolt";
import { config } from "dotenv";
import { db } from "./lib/database";
import { embeddingService } from "./lib/openai";
import { helperMatchingService, HelperSkill } from "./services/matching";
import { errorHandler } from "./utils/errorHandler";
import { sendWeeklyPrompts } from "./jobs/weekly-prompt";
import { UserService } from "./services/users";

config();

// Create receiver - use ExpressReceiver if OAuth credentials are provided
let receiver: ExpressReceiver | undefined;

if (process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET) {
  receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
    stateSecret: "my-state-secret",
    scopes: [
      "chat:write",
      "im:write",
      "users:read",
      "channels:read",
      "commands",
    ],
    installerOptions: {
      userScopes: [],
    },
  });

  // Add OAuth callback handler
  receiver.router.get("/slack/oauth_redirect", async (req, res) => {
    const code = req.query.code as string;

    if (code) {
      try {
        // Exchange code for access token
        const response = await receiver!.installer?.handleCallback(req, res, {
          success: async (installation, installOptions, req, res) => {
            console.log("\n🎉 ====== SLACK APP INSTALLED SUCCESSFULLY ======");
            console.log(
              "📝 Bot Token (add this to your .env as SLACK_BOT_TOKEN):"
            );
            console.log(`   ${installation.bot?.token}`);
            console.log("📝 Team Info:");
            console.log(`   Team ID: ${installation.team?.id}`);
            console.log(`   Team Name: ${installation.team?.name}`);
            console.log("================================================\n");

            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`
              <html>
                <body style="font-family: sans-serif; padding: 40px; max-width: 600px; margin: 0 auto;">
                  <h1>✅ Installation Successful!</h1>
                  <p>The Offers and Asks app has been installed to your workspace.</p>
                  <h2>Bot Token:</h2>
                  <pre style="background: #f0f0f0; padding: 15px; border-radius: 5px; overflow-x: auto;">
${installation.bot?.token}
                  </pre>
                  <p><strong>⚠️ Important:</strong> Copy the bot token above and add it to your .env file as:</p>
                  <pre style="background: #f0f0f0; padding: 15px; border-radius: 5px;">
SLACK_BOT_TOKEN=${installation.bot?.token}
                  </pre>
                  <p>You can now close this window.</p>
                </body>
              </html>
            `);
          },
          failure: (error, installOptions, req, res) => {
            console.error("❌ Installation failed:", error);
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Installation failed! Check server logs for details.");
          },
        });
      } catch (error) {
        console.error("❌ OAuth error:", error);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("OAuth error occurred");
      }
    } else {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("No code provided");
    }
  });

  console.log("📱 OAuth installation enabled at /slack/oauth_redirect");
}

// Create app with or without OAuth receiver
export const app = receiver
  ? new App({ receiver, token: process.env.SLACK_BOT_TOKEN })
  : new App({
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
      token: process.env.SLACK_BOT_TOKEN!,
      socketMode: false,
    });

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
    // Only create Slack link if ID starts with 'U' (valid user ID)
    const userDisplay = helper.id.startsWith("U")
      ? `<@${helper.id}>`
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
            text: `👥 *Found ${users.length} users in workspace*\n\nShowing first 20:`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: userList,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Use the "Sync Users" button to add all users to the database`,
            },
          ],
        },
      ],
    });
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
app.message(async ({ message, client, say }) => {
  try {
    // Only process DMs (not channel messages or bot messages)
    if ((message as any).channel_type !== "im" || (message as any).subtype) {
      return;
    }

    const userId = (message as any).user;
    const messageText = (message as any).text;
    const ts = (message as any).ts;
    const channel = (message as any).channel;

    // Skip if message is too short
    if (!messageText || messageText.length < 3) {
      await say({
        thread_ts: ts,
        text: "Please describe what you need help with in more detail. For example: 'I need help setting up React testing with Jest'",
      });
      return;
    }

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

      // Store the need in the database for tracking
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
      const needEmbedding = await embeddingService.generateEmbedding(
        messageText
      );
      await db.createWeeklyNeed(
        userId,
        messageText,
        needEmbedding,
        weekStart.toISOString().split("T")[0]
      );
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

// Error handling for unhandled events
app.error(async (error) => {
  console.error("Slack app error:", error);
  await errorHandler.handle(error, "slack_app_error");
});

export default app;
