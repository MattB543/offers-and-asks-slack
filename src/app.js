"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
const bolt_1 = require("@slack/bolt");
const dotenv_1 = require("dotenv");
const database_1 = require("./lib/database");
const openai_1 = require("./lib/openai");
const matching_1 = require("./services/matching");
const errorHandler_1 = require("./utils/errorHandler");
(0, dotenv_1.config)();
exports.app = new bolt_1.App({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    token: process.env.SLACK_BOT_TOKEN,
    socketMode: false,
});
// Health check endpoint
exports.app.use(async ({ next }) => {
    await next();
});
// App home opened event
exports.app.event('app_home_opened', async ({ event, client }) => {
    try {
        const userId = event.user;
        // Ensure user exists in database
        const userInfo = await client.users.info({ user: userId });
        await database_1.db.createPerson(userId, userInfo.user?.real_name || userInfo.user?.name || 'Unknown');
        // Get user's skills
        const userSkills = await database_1.db.getPersonSkills(userId);
        await client.views.publish({
            user_id: userId,
            view: {
                type: 'home',
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: '*Welcome to Helper Matcher! 🤝*\n\nThis app helps connect team members who need help with those who have the right skills.'
                        }
                    },
                    {
                        type: 'divider'
                    },
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: '*Your Skills*'
                        },
                        accessory: {
                            type: 'button',
                            text: {
                                type: 'plain_text',
                                text: 'Manage Skills'
                            },
                            action_id: 'manage_skills'
                        }
                    },
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: userSkills.length > 0
                                    ? `Skills: ${userSkills.map(s => s.skill).join(', ')}`
                                    : 'No skills added yet. Click "Manage Skills" to add some!'
                            }
                        ]
                    },
                    {
                        type: 'divider'
                    },
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: '*Need Help?*'
                        },
                        accessory: {
                            type: 'button',
                            text: {
                                type: 'plain_text',
                                text: 'Find Helpers'
                            },
                            action_id: 'find_helpers'
                        }
                    },
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: 'Get personalized helper suggestions based on what you need help with.'
                            }
                        ]
                    }
                ]
            }
        });
    }
    catch (error) {
        await errorHandler_1.errorHandler.handle(error, 'app_home_opened', { userId: event.user });
    }
});
// Handle "Need Help?" button from weekly DM
exports.app.action('open_need_modal', async ({ ack, body, client }) => {
    await ack();
    try {
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                callback_id: 'need_help_modal',
                title: {
                    type: 'plain_text',
                    text: 'What do you need help with?'
                },
                submit: {
                    type: 'plain_text',
                    text: 'Find Helpers'
                },
                close: {
                    type: 'plain_text',
                    text: 'Cancel'
                },
                blocks: [
                    {
                        type: 'input',
                        block_id: 'need_input',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'need_text',
                            multiline: true,
                            placeholder: {
                                type: 'plain_text',
                                text: 'Describe what you need help with... (e.g., "Setting up React testing with Jest", "Optimizing PostgreSQL queries", etc.)'
                            }
                        },
                        label: {
                            type: 'plain_text',
                            text: 'Your need'
                        }
                    }
                ]
            }
        });
    }
    catch (error) {
        await errorHandler_1.errorHandler.handle(error, 'open_need_modal', { userId: body.user.id });
    }
});
// Handle "Find Helpers" button from app home
exports.app.action('find_helpers', async ({ ack, body, client }) => {
    await ack();
    try {
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                callback_id: 'need_help_modal',
                title: {
                    type: 'plain_text',
                    text: 'What do you need help with?'
                },
                submit: {
                    type: 'plain_text',
                    text: 'Find Helpers'
                },
                close: {
                    type: 'plain_text',
                    text: 'Cancel'
                },
                blocks: [
                    {
                        type: 'input',
                        block_id: 'need_input',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'need_text',
                            multiline: true,
                            placeholder: {
                                type: 'plain_text',
                                text: 'Describe what you need help with... (e.g., "Setting up React testing with Jest", "Optimizing PostgreSQL queries", etc.)'
                            }
                        },
                        label: {
                            type: 'plain_text',
                            text: 'Your need'
                        }
                    }
                ]
            }
        });
    }
    catch (error) {
        await errorHandler_1.errorHandler.handle(error, 'find_helpers', { userId: body.user.id });
    }
});
// Handle "Manage Skills" button
exports.app.action('manage_skills', async ({ ack, body, client }) => {
    await ack();
    try {
        const userId = body.user.id;
        const userSkills = await database_1.db.getPersonSkills(userId);
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                callback_id: 'manage_skills_modal',
                title: {
                    type: 'plain_text',
                    text: 'Manage Your Skills'
                },
                submit: {
                    type: 'plain_text',
                    text: 'Add Skills'
                },
                close: {
                    type: 'plain_text',
                    text: 'Done'
                },
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: '*Current Skills:*'
                        }
                    },
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: userSkills.length > 0
                                    ? userSkills.map(s => `• ${s.skill}`).join('\n')
                                    : 'No skills added yet.'
                            }
                        ]
                    },
                    {
                        type: 'input',
                        block_id: 'skills_input',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'skills_text',
                            placeholder: {
                                type: 'plain_text',
                                text: 'Add skills separated by commas (e.g., React, Node.js, PostgreSQL, Machine Learning)'
                            }
                        },
                        label: {
                            type: 'plain_text',
                            text: 'Add new skills'
                        },
                        optional: true
                    }
                ]
            }
        });
    }
    catch (error) {
        await errorHandler_1.errorHandler.handle(error, 'manage_skills', { userId: body.user.id });
    }
});
// Handle need help modal submission
exports.app.view('need_help_modal', async ({ ack, body, view, client }) => {
    await ack();
    try {
        const userId = body.user.id;
        const needText = view.state.values.need_input.need_text.value;
        if (!needText) {
            return;
        }
        // Find helpers for this need
        const helpers = await matching_1.helperMatchingService.findHelpers(needText, userId);
        // Create DM with user
        const dmChannel = await client.conversations.open({ users: userId });
        if (helpers.length === 0) {
            await client.chat.postMessage({
                channel: dmChannel.channel.id,
                text: "I couldn't find any helpers for your specific need right now. Try rephrasing your request or check back later as more people add skills to their profiles."
            });
            return;
        }
        // Format helper suggestions
        const helperText = helpers.map(helper => `• *${helper.name}* – ${helper.skills.slice(0, 3).join(', ')}`).join('\n');
        await client.chat.postMessage({
            channel: dmChannel.channel.id,
            text: `Here are ${helpers.length} people who might help with: "${needText}"`,
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `*Here are ${Math.min(helpers.length, 5)} people who might help:*\n\n${helperText}`
                    }
                },
                {
                    type: 'context',
                    elements: [
                        {
                            type: 'mrkdwn',
                            text: "💡 Reach out to them directly for help!"
                        }
                    ]
                }
            ]
        });
    }
    catch (error) {
        await errorHandler_1.errorHandler.handle(error, 'need_help_modal', { userId: body.user.id });
    }
});
// Handle skills modal submission
exports.app.view('manage_skills_modal', async ({ ack, body, view, client }) => {
    await ack();
    try {
        const userId = body.user.id;
        const skillsText = view.state.values.skills_input?.skills_text?.value;
        if (!skillsText) {
            return;
        }
        // Parse and add skills
        const newSkills = skillsText.split(',').map(s => s.trim()).filter(s => s.length > 0);
        const addedSkills = [];
        for (const skill of newSkills) {
            // Create or get skill
            let skillRecord = await database_1.db.getSkillByText(skill);
            if (!skillRecord) {
                const skillId = await database_1.db.createSkill(skill);
                // Generate embedding for new skill
                const embedding = await openai_1.embeddingService.generateEmbedding(skill);
                await database_1.db.updateSkillEmbedding(skillId, embedding);
                skillRecord = { id: skillId, skill };
            }
            // Add skill to user
            await database_1.db.addPersonSkill(userId, skillRecord.id);
            addedSkills.push(skill);
        }
        if (addedSkills.length > 0) {
            // Send confirmation DM
            const dmChannel = await client.conversations.open({ users: userId });
            await client.chat.postMessage({
                channel: dmChannel.channel.id,
                text: `✅ Added ${addedSkills.length} skill(s): ${addedSkills.join(', ')}`
            });
        }
    }
    catch (error) {
        await errorHandler_1.errorHandler.handle(error, 'manage_skills_modal', { userId: body.user.id });
    }
});
// Handle DMs for future features
exports.app.message(async ({ message, client }) => {
    try {
        if (message.channel_type === 'im') {
            // This is a DM - could handle natural language skill addition or help requests
            await client.chat.postMessage({
                channel: message.channel,
                text: "Hi! 👋 Use the buttons in our app home to manage your skills or find helpers. Type `/helpme` for quick access to features."
            });
        }
    }
    catch (error) {
        await errorHandler_1.errorHandler.handle(error, 'message', { channel: message.channel });
    }
});
// Error handling for unhandled events
exports.app.error(async (error) => {
    console.error('Slack app error:', error);
    await errorHandler_1.errorHandler.handle(error, 'slack_app_error');
});
exports.default = exports.app;
//# sourceMappingURL=app.js.map