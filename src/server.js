"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = require("dotenv");
const bree_1 = __importDefault(require("bree"));
const path_1 = __importDefault(require("path"));
const app_1 = require("./app");
const database_1 = require("./lib/database");
const openai_1 = require("./lib/openai");
const errorHandler_1 = require("./utils/errorHandler");
(0, dotenv_1.config)();
const PORT = process.env.PORT || 3000;
class Server {
    bree = null;
    async start() {
        try {
            console.log('🚀 Starting Helper Matcher server...');
            // Initialize database schema
            await this.initializeDatabase();
            // Health check services
            await this.performHealthChecks();
            // Initialize job scheduler
            this.initializeScheduler();
            // Set the Slack app in error handler
            errorHandler_1.errorHandler.setSlackApp(app_1.app);
            // Add health endpoint
            app_1.app.receiver.app.get('/health', async (req, res) => {
                try {
                    const dbHealthy = await database_1.db.healthCheck();
                    if (dbHealthy) {
                        res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
                    }
                    else {
                        res.status(503).json({ status: 'unhealthy', error: 'Database connection failed' });
                    }
                }
                catch (error) {
                    res.status(503).json({ status: 'unhealthy', error: error.message });
                }
            });
            // Start Slack app
            await app_1.app.start(PORT);
            console.log(`⚡️ Slack app is running on port ${PORT}`);
            // Start job scheduler
            if (this.bree) {
                this.bree.start();
                console.log('📅 Job scheduler started');
            }
            // Notify admin that server started
            await errorHandler_1.errorHandler.notifyAdmin('🚀 Helper Matcher server started successfully');
            console.log('✅ Server startup complete');
        }
        catch (error) {
            console.error('❌ Server startup failed:', error);
            await errorHandler_1.errorHandler.handle(error, 'server_startup');
            process.exit(1);
        }
    }
    async initializeDatabase() {
        try {
            console.log('🗄️  Initializing database...');
            await database_1.db.initializeSchema();
            console.log('✅ Database initialized');
        }
        catch (error) {
            console.error('❌ Database initialization failed:', error);
            throw error;
        }
    }
    async performHealthChecks() {
        console.log('🔍 Performing health checks...');
        // Check database connection
        const dbHealthy = await database_1.db.healthCheck();
        if (!dbHealthy) {
            throw new Error('Database health check failed');
        }
        console.log('✅ Database health check passed');
        // Check OpenAI connection
        try {
            const openaiHealthy = await openai_1.embeddingService.healthCheck();
            if (!openaiHealthy) {
                throw new Error('OpenAI health check failed');
            }
            console.log('✅ OpenAI health check passed');
        }
        catch (error) {
            console.warn('⚠️  OpenAI health check failed - continuing anyway:', error);
        }
        // Check required environment variables
        const requiredEnvVars = [
            'SLACK_BOT_TOKEN',
            'SLACK_SIGNING_SECRET',
            'OPENAI_API_KEY'
        ];
        for (const envVar of requiredEnvVars) {
            if (!process.env[envVar]) {
                throw new Error(`Required environment variable ${envVar} is not set`);
            }
        }
        console.log('✅ Environment variables check passed');
    }
    initializeScheduler() {
        try {
            console.log('📅 Initializing job scheduler...');
            this.bree = new bree_1.default({
                root: path_1.default.join(__dirname, 'jobs'),
                jobs: [
                    {
                        name: 'weekly-prompt',
                        // Monday 9:00 AM Eastern Time
                        cron: '0 9 * * 1',
                        timezone: 'America/New_York'
                    }
                ],
                errorHandler: async (error, workerMetadata) => {
                    console.error(`Job error in ${workerMetadata.name}:`, error);
                    await errorHandler_1.errorHandler.handle(error, `job_${workerMetadata.name}`, workerMetadata);
                }
            });
            console.log('✅ Job scheduler initialized');
        }
        catch (error) {
            console.error('❌ Job scheduler initialization failed:', error);
            throw error;
        }
    }
    async stop() {
        console.log('🛑 Stopping server...');
        try {
            // Stop job scheduler
            if (this.bree) {
                await this.bree.stop();
                console.log('📅 Job scheduler stopped');
            }
            // Stop Slack app
            await app_1.app.stop();
            console.log('⚡️ Slack app stopped');
            // Close database connections
            await database_1.db.close();
            console.log('🗄️  Database connections closed');
            console.log('✅ Server stopped gracefully');
        }
        catch (error) {
            console.error('❌ Error during server shutdown:', error);
            await errorHandler_1.errorHandler.handle(error, 'server_shutdown');
        }
    }
}
const server = new Server();
// Graceful shutdown handling
process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    await server.stop();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    await server.stop();
    process.exit(0);
});
// Handle unhandled promise rejections
process.on('unhandledRejection', async (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    await errorHandler_1.errorHandler.handle(reason, 'unhandled_rejection');
});
// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    await errorHandler_1.errorHandler.handle(error, 'uncaught_exception');
    process.exit(1);
});
// Start the server
server.start();
//# sourceMappingURL=server.js.map