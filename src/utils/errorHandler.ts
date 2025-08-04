import { App } from '@slack/bolt';

export class ErrorHandler {
  private slackApp: App | null = null;

  setSlackApp(app: App) {
    this.slackApp = app;
  }

  async handle(error: any, context: string, metadata?: any): Promise<void> {
    console.error(`Error in ${context}:`, error);
    console.error('Metadata:', metadata);

    // Don't send admin notifications in development
    if (process.env.NODE_ENV === 'development') {
      return;
    }

    if (!this.slackApp) {
      console.warn('Slack app not set, skipping admin notification');
      return;
    }

    try {
      const adminUserId = process.env.ADMIN_USER_ID;
      if (!adminUserId) {
        console.warn('ADMIN_USER_ID not set, skipping admin notification');
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : 'No stack trace';

      await this.slackApp.client.chat.postMessage({
        channel: adminUserId,
        text: `🚨 Helper-bot error in \`${context}\``,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `🚨 *Helper-bot error in \`${context}\`*`
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Error:* ${errorMessage}`
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Context:* ${JSON.stringify(metadata, null, 2)}`
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Stack:*\n\`\`\`${errorStack?.substring(0, 500) || 'No stack trace'}\`\`\``
            }
          }
        ]
      });
    } catch (notificationError) {
      console.error('Failed to send admin notification:', notificationError);
    }
  }

  async notifyAdmin(message: string, blocks?: any[]): Promise<void> {
    if (!this.slackApp) {
      console.warn('Slack app not set, skipping admin notification');
      return;
    }

    try {
      const adminUserId = process.env.ADMIN_USER_ID;
      if (!adminUserId) {
        console.warn('ADMIN_USER_ID not set, skipping admin notification');
        return;
      }

      await this.slackApp.client.chat.postMessage({
        channel: adminUserId,
        text: message,
        blocks: blocks
      });
    } catch (error) {
      console.error('Failed to send admin notification:', error);
    }
  }
}

export const errorHandler = new ErrorHandler();