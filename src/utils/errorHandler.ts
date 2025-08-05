import { App } from "@slack/bolt";

export class ErrorHandler {
  public slackApp: App | null = null;

  setSlackApp(app: App) {
    this.slackApp = app;
  }

  async handle(error: any, context: string, metadata?: any): Promise<void> {
    // Always log to console
    console.error(`[${context}] Error:`, error);
    if (metadata) {
      console.error(`[${context}] Metadata:`, metadata);
    }

    // Skip Slack notifications in development
    if (process.env.NODE_ENV === "development") {
      return;
    }

    // Send admin notification if possible
    await this.notifyAdminError(error, context, metadata);
  }

  private async notifyAdminError(
    error: any,
    context: string,
    metadata?: any
  ): Promise<void> {
    if (!this.slackApp || !process.env.ADMIN_USER_ID) {
      return;
    }

    try {
      const adminIds = process.env.ADMIN_USER_ID.split(",").map((id) =>
        id.trim()
      );
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack =
        error instanceof Error && error.stack
          ? error.stack.substring(0, 500)
          : "No stack trace";

      // Send to each admin
      for (const adminId of adminIds) {
        await this.slackApp.client.chat.postMessage({
          channel: adminId,
          text: `🚨 Error in ${context}`,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: "🚨 System Error",
                emoji: true,
              },
            },
            {
              type: "section",
              fields: [
                {
                  type: "mrkdwn",
                  text: `*Context:*\n${context}`,
                },
                {
                  type: "mrkdwn",
                  text: `*Time:*\n${new Date().toISOString()}`,
                },
              ],
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Error:*\n\`\`\`${errorMessage}\`\`\``,
              },
            },
          ],
        });
      }
    } catch (notificationError) {
      console.error("Failed to send admin notification:", notificationError);
    }
  }

  async notifyAdmin(message: string, blocks?: any[]): Promise<void> {
    if (!this.slackApp || !process.env.ADMIN_USER_ID) {
      console.log(`[Admin Notification] ${message}`);
      return;
    }

    try {
      const adminIds = process.env.ADMIN_USER_ID.split(",").map((id) =>
        id.trim()
      );

      for (const adminId of adminIds) {
        await this.slackApp.client.chat.postMessage({
          channel: adminId,
          text: message,
          blocks: blocks || [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: message,
              },
            },
          ],
        });
      }
    } catch (error) {
      console.error("Failed to send admin notification:", error);
    }
  }
}

export const errorHandler = new ErrorHandler();
