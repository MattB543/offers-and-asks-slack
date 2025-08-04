"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = exports.ErrorHandler = void 0;
const bolt_1 = require("@slack/bolt");
class ErrorHandler {
    slackApp = null;
    setSlackApp(app) {
        this.slackApp = app;
    }
    async handle(error, context, metadata) {
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
        }
        catch (notificationError) {
            console.error('Failed to send admin notification:', notificationError);
        }
    }
    async notifyAdmin(message, blocks) {
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
        }
        catch (error) {
            console.error('Failed to send admin notification:', error);
        }
    }
}
exports.ErrorHandler = ErrorHandler;
exports.errorHandler = new ErrorHandler();
//# sourceMappingURL=errorHandler.js.map