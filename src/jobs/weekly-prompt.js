"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendWeeklyPrompts = sendWeeklyPrompts;
const dotenv_1 = require("dotenv");
const bolt_1 = require("@slack/bolt");
const database_1 = require("../lib/database");
const errorHandler_1 = require("../utils/errorHandler");
(0, dotenv_1.config)();
async function sendWeeklyPrompts() {
    console.log('Starting weekly prompt job...');
    // Create Slack app instance
    const slackApp = new bolt_1.App({
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        token: process.env.SLACK_BOT_TOKEN,
    });
    try {
        // Get all enabled users
        const enabledUsers = await database_1.db.getAllEnabledPeople();
        console.log(`Found ${enabledUsers.length} enabled users`);
        let successCount = 0;
        let errorCount = 0;
        for (const user of enabledUsers) {
            try {
                // Open DM channel with user
                const dmResponse = await slackApp.client.conversations.open({
                    users: user.slack_id
                });
                if (!dmResponse.ok || !dmResponse.channel) {
                    throw new Error(`Failed to open DM with ${user.slack_id}: ${dmResponse.error}`);
                }
                // Send weekly prompt message
                await slackApp.client.chat.postMessage({
                    channel: dmResponse.channel.id,
                    text: 'What do you need help with this week?',
                    blocks: [
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: '*What do you need help with this week?* 🤝'
                            }
                        },
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: 'Click the button below to tell me what you need help with, and I\'ll find teammates with the right skills to assist you.'
                            }
                        },
                        {
                            type: 'actions',
                            elements: [
                                {
                                    type: 'button',
                                    text: {
                                        type: 'plain_text',
                                        text: '💡 Tell me what you need',
                                        emoji: true
                                    },
                                    action_id: 'open_need_modal',
                                    style: 'primary'
                                }
                            ]
                        },
                        {
                            type: 'context',
                            elements: [
                                {
                                    type: 'mrkdwn',
                                    text: 'You can also manage your skills or find helpers anytime by visiting our app home.'
                                }
                            ]
                        }
                    ]
                });
                successCount++;
                console.log(`✅ Sent weekly prompt to ${user.display_name} (${user.slack_id})`);
                // Add small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            catch (userError) {
                errorCount++;
                console.error(`❌ Failed to send prompt to ${user.display_name} (${user.slack_id}):`, userError);
                // Continue with other users, but log the error
                await errorHandler_1.errorHandler.handle(userError, 'weekly_prompt_individual', {
                    userId: user.slack_id,
                    userName: user.display_name
                });
            }
        }
        console.log(`Weekly prompt job completed: ${successCount} success, ${errorCount} errors`);
        // Send summary to admin
        await errorHandler_1.errorHandler.notifyAdmin(`📊 Weekly prompt job completed`, [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `📊 *Weekly Prompt Job Summary*\n• ✅ Success: ${successCount}\n• ❌ Errors: ${errorCount}\n• 👥 Total users: ${enabledUsers.length}`
                }
            }
        ]);
    }
    catch (error) {
        console.error('Weekly prompt job failed:', error);
        await errorHandler_1.errorHandler.handle(error, 'weekly_prompt_job');
        throw error;
    }
}
// Execute if called directly
if (require.main === module) {
    sendWeeklyPrompts()
        .then(() => {
        console.log('Weekly prompt job finished successfully');
        process.exit(0);
    })
        .catch((error) => {
        console.error('Weekly prompt job failed:', error);
        process.exit(1);
    });
}
//# sourceMappingURL=weekly-prompt.js.map