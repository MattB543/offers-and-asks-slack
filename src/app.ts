import { App } from "@slack/bolt";
import { config } from "dotenv";
import { db } from "./lib/database";
import { embeddingService } from "./lib/openai";
import { helperMatchingService } from "./services/matching";
import { errorHandler } from "./utils/errorHandler";
import { sendWeeklyPrompts } from "./jobs/weekly-prompt";

config();

export const app = new App({
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

  const helperText = helpers
    .slice(0, 5)
    .map(
      (helper) =>
        `• <@${helper.id}> – ${helper.skills
          .slice(0, 3)
          .join(", ")} _(score: ${(helper.score * 100).toFixed(0)}%)_`
    )
    .join("\n");

  return {
    text: `Found ${helpers.length} people who might help with: "${needText}"`,
    blocks: [
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
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Top matches:*\n${helperText}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "💡 Click on their names to send them a message!",
          },
        ],
      },
    ],
  };
};

// App home opened event
app.event("app_home_opened", async ({ event, client }) => {
  try {
    const userId = event.user;

    // Ensure user exists in database
    const userInfo = await client.users.info({ user: userId });
    await db.createPerson(
      userId,
      userInfo.user?.real_name || userInfo.user?.name || "Unknown"
    );

    // Get user's skills
    const userSkills = await db.getPersonSkills(userId);

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
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Your Skills*",
        },
        accessory: {
          type: "button",
          text: {
            type: "plain_text",
            text: "Manage Skills",
          },
          action_id: "manage_skills",
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
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Need Help?*",
        },
        accessory: {
          type: "button",
          text: {
            type: "plain_text",
            text: "Find Helpers",
          },
          action_id: "find_helpers",
          style: "primary",
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
    ];

    // Add admin section if user is admin
    if (isAdmin(userId)) {
      // Get weekly stats
      const stats = await helperMatchingService.getWeeklyStats();

      blocks.push(
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*🔧 Admin Controls*",
          },
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
        }
      );
    }

    await client.views.publish({
      user_id: userId,
      view: {
        type: "home",
        blocks,
      },
    });
  } catch (error) {
    await errorHandler.handle(error, "app_home_opened", { userId: event.user });
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
    const dmChannel = await client.conversations.open({ users: userId });
    await client.chat.postMessage({
      channel: dmChannel.channel?.id || "",
      text: "🧪 Test DM from Offers and Asks bot!",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: '🧪 *Test DM successful!*\n\nYou can send me messages like:\n• "I need help with React testing"\n• "Looking for someone who knows PostgreSQL"\n• "Need assistance with Docker deployment"',
          },
        },
      ],
    });
  } catch (error) {
    await errorHandler.handle(error, "admin_test_dm", { userId });
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

    // Create DM with user
    const dmChannel = await client.conversations.open({ users: userId });

    // Format and send results
    const results = formatHelperResults(helpers, needText);
    await client.chat.postMessage({
      channel: dmChannel.channel?.id || "",
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

    // Send confirmation
    if (addedSkills.length > 0 || removedSkills.length > 0) {
      const dmChannel = await client.conversations.open({ users: userId });
      let message = "✅ Skills updated!\n";
      if (addedSkills.length > 0) {
        message += `\n*Added:* ${addedSkills.join(", ")}`;
      }
      if (removedSkills.length > 0) {
        message += `\n*Removed:* ${removedSkills.join(", ")}`;
      }

      await client.chat.postMessage({
        channel: dmChannel.channel?.id || "",
        text: message,
      });
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
