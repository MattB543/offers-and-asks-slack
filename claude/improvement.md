[offers-and-asks-slack] [2025-08-05 20:30:22] > offers-and-asks-slack@1.0.0 start
[offers-and-asks-slack] [2025-08-05 20:30:22] > node dist/server.js
[offers-and-asks-slack] [2025-08-05 20:30:22]
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔧 Database constructor starting...
[offers-and-asks-slack] [2025-08-05 20:30:24] 📊 DATABASE_URL exists: true
[offers-and-asks-slack] [2025-08-05 20:30:24] 📊 Original DATABASE_URL: postgresql://doadmin:AVNS_LORmuf49GH_FzjR9G-5@offe...
[offers-and-asks-slack] [2025-08-05 20:30:24] 📊 Is DigitalOcean database: true
[offers-and-asks-slack] [2025-08-05 20:30:24] 📊 NODE_ENV: production
[offers-and-asks-slack] [2025-08-05 20:30:24] ⚠️ Removing sslmode from DATABASE_URL to avoid conflicts
[offers-and-asks-slack] [2025-08-05 20:30:24] 📊 Cleaned DATABASE_URL: postgresql://doadmin:AVNS_LORmuf49GH_FzjR9G-5@offe...
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔐 Using DigitalOcean/Production SSL configuration
[offers-and-asks-slack] [2025-08-05 20:30:24] 📊 Added sslmode=no-verify to connection string
[offers-and-asks-slack] [2025-08-05 20:30:24] 📊 Final connection string includes sslmode: true
[offers-and-asks-slack] [2025-08-05 20:30:24] 📊 Pool config has ssl object: false
[offers-and-asks-slack] [2025-08-05 20:30:24] ✅ Pool created successfully
[offers-and-asks-slack] [2025-08-05 20:30:24] [dotenv@17.2.1] injecting env (0) from .env -- tip: ⚙️ suppress all logs with { quiet: true }
[offers-and-asks-slack] [2025-08-05 20:30:24] [dotenv@17.2.1] injecting env (0) from .env -- tip: 📡 version env with Radar: https://dotenvx.com/radar
[offers-and-asks-slack] [2025-08-05 20:30:24] 🚀 Server file loaded
[offers-and-asks-slack] [2025-08-05 20:30:24] 🚀 Current working directory: /workspace
[offers-and-asks-slack] [2025-08-05 20:30:24] 🚀 \_\_dirname: /workspace/dist
[offers-and-asks-slack] [2025-08-05 20:30:24] [dotenv@17.2.1] injecting env (0) from .env -- tip: 📡 auto-backup env with Radar: https://dotenvx.com/radar
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔧 Environment variables loaded
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔧 NODE_ENV: production
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔧 PORT: 8080
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔧 DATABASE_URL exists: true
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔧 SLACK_BOT_TOKEN exists: true
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔧 SLACK_SIGNING_SECRET exists: true
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔧 OPENAI_API_KEY exists: true
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔧 ADMIN_USER_ID exists: true
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔧 DATABASE_URL: [REDACTED - length: 145]
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔧 NODE: /workspace/.heroku/node/bin/node
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔧 NODE_HOME: /workspace/.heroku/node
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔧 NODE_ENV: production
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔧 Server will use PORT: 8080
[offers-and-asks-slack] [2025-08-05 20:30:24] 📦 Creating server instance...
[offers-and-asks-slack] [2025-08-05 20:30:24] 📦 Server instance created
[offers-and-asks-slack] [2025-08-05 20:30:24] 🚀 Calling server.start()...
[offers-and-asks-slack] [2025-08-05 20:30:24] 🚀 Starting Helper Matcher server...
[offers-and-asks-slack] [2025-08-05 20:30:24] 🚀 Server start timestamp: 2025-08-05T20:30:24.315Z
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔍 Performing health checks...
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔍 Health check timestamp: 2025-08-05T20:30:24.317Z
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔍 Starting database health check...
[offers-and-asks-slack] [2025-08-05 20:30:24] ✅ Database health check passed
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔍 Starting OpenAI health check...
[offers-and-asks-slack] [2025-08-05 20:30:24] ✅ OpenAI health check passed
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔍 Checking required environment variables...
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔍 SLACK_BOT_TOKEN: ✅ EXISTS
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔍 SLACK_SIGNING_SECRET: ✅ EXISTS
[offers-and-asks-slack] [2025-08-05 20:30:24] 🔍 OPENAI_API_KEY: ✅ EXISTS
[offers-and-asks-slack] [2025-08-05 20:30:24] ✅ Environment variables check passed
[offers-and-asks-slack] [2025-08-05 20:30:24] ✅ All health checks completed successfully
[offers-and-asks-slack] [2025-08-05 20:30:24] 📅 Initializing job scheduler...
[offers-and-asks-slack] [2025-08-05 20:30:24] 📅 Jobs path: /workspace/dist/jobs
[offers-and-asks-slack] [2025-08-05 20:30:24] ✅ Job scheduler initialized
[offers-and-asks-slack] [2025-08-05 20:30:24] ⚡️ Starting Slack app on port: 8080
[offers-and-asks-slack] [2025-08-05 20:30:24] ⚡️ Slack app is running on port 8080
[offers-and-asks-slack] [2025-08-05 20:30:24] 🏥 Health checks available through the bot's internal monitoring
[offers-and-asks-slack] [2025-08-05 20:30:24] 📅 Job scheduler started
[offers-and-asks-slack] [2025-08-05 20:30:24] Unhandled Rejection at: Promise {
[offers-and-asks-slack] [2025-08-05 20:30:24] <rejected> TypeError: cron is not a function
[offers-and-asks-slack] [2025-08-05 20:30:24] at validateCron (/workspace/node_modules/bree/src/job-validator.js:148:20)
[offers-and-asks-slack] [2025-08-05 20:30:24] at validate (/workspace/node_modules/bree/src/job-validator.js:280:20)
[offers-and-asks-slack] [2025-08-05 20:30:24] at async /workspace/node_modules/bree/src/index.js:297:11
[offers-and-asks-slack] [2025-08-05 20:30:24] at async Promise.all (index 0)
[offers-and-asks-slack] [2025-08-05 20:30:24] at async Bree.init (/workspace/node_modules/bree/src/index.js:293:24)
[offers-and-asks-slack] [2025-08-05 20:30:24] at async Bree.start (/workspace/node_modules/bree/src/index.js:503:22)
[offers-and-asks-slack] [2025-08-05 20:30:24] } reason: TypeError: cron is not a function
[offers-and-asks-slack] [2025-08-05 20:30:24] at validateCron (/workspace/node_modules/bree/src/job-validator.js:148:20)
[offers-and-asks-slack] [2025-08-05 20:30:24] at validate (/workspace/node_modules/bree/src/job-validator.js:280:20)
[offers-and-asks-slack] [2025-08-05 20:30:24] at async /workspace/node_modules/bree/src/index.js:297:11
[offers-and-asks-slack] [2025-08-05 20:30:24] at async Promise.all (index 0)
[offers-and-asks-slack] [2025-08-05 20:30:24] at async Bree.init (/workspace/node_modules/bree/src/index.js:293:24)
[offers-and-asks-slack] [2025-08-05 20:30:24] at async Bree.start (/workspace/node_modules/bree/src/index.js:503:22)
[offers-and-asks-slack] [2025-08-05 20:30:24] [unhandled_rejection] Error: TypeError: cron is not a function
[offers-and-asks-slack] [2025-08-05 20:30:24] at validateCron (/workspace/node_modules/bree/src/job-validator.js:148:20)
[offers-and-asks-slack] [2025-08-05 20:30:24] at validate (/workspace/node_modules/bree/src/job-validator.js:280:20)
[offers-and-asks-slack] [2025-08-05 20:30:24] at async /workspace/node_modules/bree/src/index.js:297:11
[offers-and-asks-slack] [2025-08-05 20:30:24] at async Promise.all (index 0)
[offers-and-asks-slack] [2025-08-05 20:30:24] at async Bree.init (/workspace/node_modules/bree/src/index.js:293:24)
[offers-and-asks-slack] [2025-08-05 20:30:24] at async Bree.start (/workspace/node_modules/bree/src/index.js:503:22)
[offers-and-asks-slack] [2025-08-05 20:30:24] ✅ Server startup complete
