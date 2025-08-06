import { config } from "dotenv";
import { WebClient } from "@slack/web-api";
import { db } from "../lib/database";
import { errorHandler } from "../utils/errorHandler";

config();

export async function sendWeeklyPrompts(): Promise<{
  successCount: number;
  errorCount: number;
}> {
  console.log("Starting weekly prompt job...");

  // Create a simple WebClient instance
  const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN!);

  let successCount = 0;
  let errorCount = 0;
  const errors: Array<{ user: string; error: string }> = [];

  try {
    // Get all enabled users
    const enabledUsers = await db.getAllEnabledPeople();
    console.log(`Found ${enabledUsers.length} enabled users`);

    // Process users in batches to avoid rate limiting
    const batchSize = 10;
    for (let i = 0; i < enabledUsers.length; i += batchSize) {
      const batch = enabledUsers.slice(i, i + batchSize);

      // Process batch in parallel
      await Promise.all(
        batch.map(async (user) => {
          try {
            // Send weekly prompt message directly to user
            await slackClient.chat.postMessage({
              channel: user.user_id,
              text: "What do you need help with this week?",
              blocks: [
                {
                  type: "divider",
                },
                {
                  type: "header",
                  text: {
                    type: "plain_text",
                    text: "🤝 Weekly Check-in",
                    emoji: true,
                  },
                },
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `Hey ${user.display_name}! What do you need help with this week?`,
                  },
                },
                {
                  type: "context",
                  elements: [
                    {
                      type: "mrkdwn",
                      text: "💬 You can simply reply to this message with what you need!",
                    },
                  ],
                },
              ],
            });

            successCount++;
            console.log(`✅ Sent to ${user.display_name} (${user.user_id})`);
          } catch (userError: any) {
            errorCount++;
            const errorMsg = userError.message || String(userError);
            errors.push({
              user: user.display_name || user.user_id,
              error: errorMsg,
            });
            console.error(`❌ Failed for ${user.display_name}:`, errorMsg);
          }
        })
      );

      // Delay between batches
      if (i + batchSize < enabledUsers.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.log(
      `Weekly prompt job completed: ${successCount} success, ${errorCount} errors`
    );

    // Send detailed summary to admin
    const adminUserId = process.env.ADMIN_USER_ID;
    if (adminUserId && errorHandler.slackApp) {
      const blocks: any[] = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "📊 Weekly Prompt Summary",
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*✅ Success:*\n${successCount}`,
            },
            {
              type: "mrkdwn",
              text: `*❌ Errors:*\n${errorCount}`,
            },
            {
              type: "mrkdwn",
              text: `*👥 Total:*\n${enabledUsers.length}`,
            },
            {
              type: "mrkdwn",
              text: `*📅 Date:*\n${new Date().toLocaleDateString()}`,
            },
          ],
        },
      ];

      // Add error details if any
      if (errors.length > 0) {
        blocks.push(
          {
            type: "divider",
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                "*Error Details:*\n" +
                errors
                  .slice(0, 5)
                  .map((e) => `• ${e.user}: ${e.error}`)
                  .join("\n"),
            },
          }
        );
      }

      await errorHandler.notifyAdmin("Weekly prompt job completed", blocks);
    }

    return { successCount, errorCount };
  } catch (error) {
    console.error("Weekly prompt job failed:", error);
    await errorHandler.handle(error, "weekly_prompt_job");
    throw error;
  }
}

// Execute if called directly
if (require.main === module) {
  sendWeeklyPrompts()
    .then((result) => {
      console.log("Weekly prompt job finished:", result);
      process.exit(0);
    })
    .catch((error) => {
      console.error("Weekly prompt job failed:", error);
      process.exit(1);
    });
}
