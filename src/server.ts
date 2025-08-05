import { config } from "dotenv";
import { app } from "./app";
import { db } from "./lib/database";
import { embeddingService } from "./lib/openai";
import { errorHandler } from "./utils/errorHandler";

console.log("🚀 Server file loaded");
console.log("🚀 Current working directory:", process.cwd());
console.log("🚀 __dirname:", __dirname);

config();

console.log("🔧 Environment variables loaded");
console.log("🔧 NODE_ENV:", process.env.NODE_ENV);
console.log("🔧 PORT:", process.env.PORT);
console.log("🔧 DATABASE_URL exists:", !!process.env.DATABASE_URL);
console.log("🔧 SLACK_BOT_TOKEN exists:", !!process.env.SLACK_BOT_TOKEN);
console.log(
  "🔧 SLACK_SIGNING_SECRET exists:",
  !!process.env.SLACK_SIGNING_SECRET
);
console.log("🔧 OPENAI_API_KEY exists:", !!process.env.OPENAI_API_KEY);
console.log("🔧 ADMIN_USER_ID exists:", !!process.env.ADMIN_USER_ID);

// Log all environment variables that start with NODE or DATABASE (be careful not to log secrets)
Object.keys(process.env).forEach((key) => {
  if (key.startsWith("NODE") || key.startsWith("DATABASE")) {
    if (key === "DATABASE_URL") {
      console.log(
        `🔧 ${key}: [REDACTED - length: ${process.env[key]?.length}]`
      );
    } else {
      console.log(`🔧 ${key}:`, process.env[key]);
    }
  }
});

const PORT = process.env.PORT || 3000;
console.log("🔧 Server will use PORT:", PORT);

class Server {

  async start() {
    try {
      console.log("🚀 Starting Helper Matcher server...");
      console.log("🚀 Server start timestamp:", new Date().toISOString());

      // Health check services
      await this.performHealthChecks();

      // Initialize job scheduler
      this.initializeScheduler();

      // Set the Slack app in error handler
      errorHandler.setSlackApp(app);

      // Create health endpoint on a different port or integrate with Slack app
      // For now, let's start the Slack app and log that health checks are available via the bot
      console.log("⚡️ Starting Slack app on port:", Number(PORT));
      await app.start(Number(PORT));
      console.log(`⚡️ Slack app is running on port ${PORT}`);
      console.log(
        `🏥 Health checks available through the bot's internal monitoring`
      );

      // Job scheduler is disabled - manual mode only
      console.log("📅 Job scheduler: DISABLED (manual weekly prompts via admin button)");

      // Notify admin that server started
      await errorHandler.notifyAdmin(
        "🚀 Helper Matcher server started successfully"
      );

      console.log("✅ Server startup complete");
    } catch (error) {
      console.error("❌ Server startup failed:", error);
      await errorHandler.handle(error, "server_startup");
      process.exit(1);
    }
  }

  private async performHealthChecks() {
    console.log("🔍 Performing health checks...");
    console.log("🔍 Health check timestamp:", new Date().toISOString());

    // Check database connection
    console.log("🔍 Starting database health check...");
    const dbHealthy = await db.healthCheck();
    if (!dbHealthy) {
      console.error("❌ Database health check returned false");
      throw new Error("Database health check failed");
    }
    console.log("✅ Database health check passed");

    // Check OpenAI connection
    console.log("🔍 Starting OpenAI health check...");
    try {
      const openaiHealthy = await embeddingService.healthCheck();
      if (!openaiHealthy) {
        console.error("⚠️ OpenAI health check returned false");
        throw new Error("OpenAI health check failed");
      }
      console.log("✅ OpenAI health check passed");
    } catch (error) {
      console.warn(
        "⚠️  OpenAI health check failed - continuing anyway:",
        error
      );
    }

    // Check required environment variables
    console.log("🔍 Checking required environment variables...");
    const requiredEnvVars = [
      "SLACK_BOT_TOKEN",
      "SLACK_SIGNING_SECRET",
      "OPENAI_API_KEY",
    ];

    for (const envVar of requiredEnvVars) {
      const exists = !!process.env[envVar];
      console.log(`🔍 ${envVar}: ${exists ? "✅ EXISTS" : "❌ MISSING"}`);
      if (!exists) {
        throw new Error(`Required environment variable ${envVar} is not set`);
      }
    }
    console.log("✅ Environment variables check passed");
    console.log("✅ All health checks completed successfully");
  }

  private initializeScheduler() {
    try {
      console.log("📅 Job scheduler disabled - weekly prompts are manual only");
      console.log("💡 Use admin controls in app home to send weekly prompts");
      
      // No automatic scheduling - weekly prompts are triggered manually via admin button
      
      console.log("✅ Manual-only mode initialized");
    } catch (error) {
      console.error("❌ Job scheduler initialization failed:", error);
      throw error;
    }
  }

  async stop() {
    console.log("🛑 Stopping server...");
    console.log("🛑 Stop timestamp:", new Date().toISOString());

    try {
      // Stop Slack app
      console.log("🛑 Stopping Slack app...");
      await app.stop();
      console.log("⚡️ Slack app stopped");

      // Close database connections
      console.log("🛑 Closing database connections...");
      await db.close();
      console.log("🗄️  Database connections closed");

      console.log("✅ Server stopped gracefully");
    } catch (error) {
      console.error("❌ Error during server shutdown:", error);
      await errorHandler.handle(error, "server_shutdown");
    }
  }
}

console.log("📦 Creating server instance...");
const server = new Server();
console.log("📦 Server instance created");

// Graceful shutdown handling
process.on("SIGINT", async () => {
  console.log("\n🛑 Received SIGINT, shutting down gracefully...");
  await server.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Received SIGTERM, shutting down gracefully...");
  await server.stop();
  process.exit(0);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", async (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  await errorHandler.handle(reason, "unhandled_rejection");
});

// Handle uncaught exceptions
process.on("uncaughtException", async (error) => {
  console.error("Uncaught Exception:", error);
  await errorHandler.handle(error, "uncaught_exception");
  process.exit(1);
});

// Start the server
console.log("🚀 Calling server.start()...");
server.start();
