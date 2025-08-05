import { config } from 'dotenv';
import Bree from 'bree';
import path from 'path';
import { app } from './app';
import { db } from './lib/database';
import { embeddingService } from './lib/openai';
import { errorHandler } from './utils/errorHandler';

config();

const PORT = process.env.PORT || 3000;

class Server {
  private bree: Bree | null = null;

  async start() {
    try {
      console.log('🚀 Starting Helper Matcher server...');

      // Health check services
      await this.performHealthChecks();

      // Initialize job scheduler
      this.initializeScheduler();

      // Set the Slack app in error handler
      errorHandler.setSlackApp(app);

      // Create health endpoint on a different port or integrate with Slack app
      // For now, let's start the Slack app and log that health checks are available via the bot
      await app.start(Number(PORT));
      console.log(`⚡️ Slack app is running on port ${PORT}`);
      console.log(`🏥 Health checks available through the bot's internal monitoring`);

      // Start job scheduler
      if (this.bree) {
        this.bree.start();
        console.log('📅 Job scheduler started');
      }

      // Notify admin that server started
      await errorHandler.notifyAdmin('🚀 Helper Matcher server started successfully');

      console.log('✅ Server startup complete');

    } catch (error) {
      console.error('❌ Server startup failed:', error);
      await errorHandler.handle(error, 'server_startup');
      process.exit(1);
    }
  }

  private async performHealthChecks() {
    console.log('🔍 Performing health checks...');

    // Check database connection
    const dbHealthy = await db.healthCheck();
    if (!dbHealthy) {
      throw new Error('Database health check failed');
    }
    console.log('✅ Database health check passed');

    // Check OpenAI connection
    try {
      const openaiHealthy = await embeddingService.healthCheck();
      if (!openaiHealthy) {
        throw new Error('OpenAI health check failed');
      }
      console.log('✅ OpenAI health check passed');
    } catch (error) {
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

  private initializeScheduler() {
    try {
      console.log('📅 Initializing job scheduler...');

      this.bree = new Bree({
        root: path.join(__dirname, 'jobs'),
        jobs: [
          {
            name: 'weekly-prompt',
            // Monday 9:00 AM Eastern Time
            cron: '0 9 * * 1',
            timezone: 'America/New_York'
          }
        ],
        errorHandler: async (error: any, workerMetadata: any) => {
          console.error(`Job error in ${workerMetadata.name}:`, error);
          await errorHandler.handle(error, `job_${workerMetadata.name}`, workerMetadata);
        }
      });

      console.log('✅ Job scheduler initialized');
    } catch (error) {
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
      await app.stop();
      console.log('⚡️ Slack app stopped');

      // Close database connections
      await db.close();
      console.log('🗄️  Database connections closed');

      console.log('✅ Server stopped gracefully');
    } catch (error) {
      console.error('❌ Error during server shutdown:', error);
      await errorHandler.handle(error, 'server_shutdown');
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
  await errorHandler.handle(reason, 'unhandled_rejection');
});

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  console.error('Uncaught Exception:', error);
  await errorHandler.handle(error, 'uncaught_exception');
  process.exit(1);
});

// Start the server
server.start();