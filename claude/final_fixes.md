Of course. I've carefully reviewed every file in your repository. You're running into deployment issues because of a combination of configuration problems, code that's a bit too complex or fragile for a production environment, and a few outright bugs.

The good news is that the core logic is sound. The issues are all fixable. The `.claude/` files contain excellent notes that have already identified many of these problems; it seems some fixes were applied, but others were missed.

Here is a step-by-step breakdown of what's wrong, what's too complex, and how to fix it to make your code simple, clean, and deployable.

---

### Summary of Critical Issues

1.  **Missing Database Schema:** The application tries to initialize a schema from `database/schema.sql` on startup, but this file **does not exist** in your repository. This is the primary reason your deployment is failing.
2.  **Overly Complex Database Connection:** The `database.ts` constructor has redundant and confusing logic for connecting to Postgres. It should be simplified to prioritize the standard `DATABASE_URL` environment variable.
3.  **Unsafe Startup Logic:** The server runs a database schema migration (`initializeSchema`) every single time it starts. This is risky in production and should be a separate, one-time setup step.
4.  **Bugs in Services:** The `matching.ts` service references a SQL table (`helper_suggestions`) that is not defined anywhere, which will cause runtime errors.

---

### Step 1: Fix Deployment & Configuration (The Blockers)

These issues will prevent your application from starting correctly in a production environment like DigitalOcean.

#### 1.1. The Missing `database/schema.sql` File

- **Problem:** `src/scripts/setup-database.ts` and `src/server.ts` both call `db.initializeSchema()`, which reads a file from `database/schema.sql`. This file is missing, causing the application to crash on startup.
- **Explanation:** Your application code depends on a file that isn't checked into your repository.
- **Fix:** Create the `database/schema.sql` file with the correct table definitions. Based on your code's queries, this is the minimal schema you need.

**Action:** Create a new folder `database` at the root of your project and add the file `schema.sql` inside it with the following content:

```sql
-- database/schema.sql

-- Enable the pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Table for users
CREATE TABLE IF NOT EXISTS people (
  slack_id TEXT PRIMARY KEY,
  display_name TEXT,
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Table for skills and their embeddings
CREATE TABLE IF NOT EXISTS skills (
  id SERIAL PRIMARY KEY,
  skill TEXT NOT NULL UNIQUE,
  embedding vector(1536), -- OpenAI text-embedding-3-small uses 1536 dimensions
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Many-to-many relationship between people and skills
CREATE TABLE IF NOT EXISTS person_skills (
  slack_id TEXT REFERENCES people(slack_id) ON DELETE CASCADE,
  skill_id INT REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (slack_id, skill_id)
);

-- Table to log weekly help requests
CREATE TABLE IF NOT EXISTS weekly_needs (
  id SERIAL PRIMARY KEY,
  slack_id TEXT REFERENCES people(slack_id) ON DELETE CASCADE,
  need_text TEXT NOT NULL,
  need_embedding vector(1536),
  week_start DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Optional: Create an index for faster vector similarity searches later
-- CREATE INDEX ON skills USING hnsw (embedding vector_cosine_ops);
```

#### 1.2. Simplify and Harden the Database Connection

- **Problem:** `src/lib/database.ts` has a complicated constructor that tries to use `DATABASE_URL` and also individual variables like `DB_HOST`, `DB_USER`, etc. The `ssl: { rejectUnauthorized: false }` is a security risk and often unnecessary.
- **Explanation:** Production environments (DigitalOcean, Heroku) provide a single `DATABASE_URL`. Your code should simply use it. This removes complexity and potential configuration errors.
- **Fix:** Drastically simplify the `Database` class constructor.

**Action:** Replace the entire `constructor` in `src/lib/database.ts` with this:

```typescript
// src/lib/database.ts

// ... imports

export class Database {
  private pool: Pool;

  constructor() {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is not set.');
    }

    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Production environments like DigitalOcean and Heroku often require SSL
      // The connection string usually handles this, but you can be explicit if needed.
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false } // A common setting for managed DBs, but check your provider's docs
        : false,
    });
  }

  // ... rest of the class
```

_Note: The `rejectUnauthorized: false` is kept for compatibility with many managed database providers, but if your provider gives you a CA certificate, a more secure configuration should be used._

#### 1.3. Make the Server Startup Safe

- **Problem:** `src/server.ts` calls `initializeDatabase()` on every start.
- **Explanation:** Running `CREATE TABLE` queries every time the app boots is unnecessary and risky. It can lead to errors or unintended data resets. Database setup should be a deliberate, one-time action during deployment. You already have a script for this (`npm run setup-db`).
- **Fix:** Remove the schema initialization from the server's startup sequence.

**Action:** In `src/server.ts`, delete the line that calls `initializeDatabase()`.

```typescript
// src/server.ts

// ... in the Server class start() method

  async start() {
    try {
      console.log('🚀 Starting Helper Matcher server...');

      // ----------------------------------------------------
      // DELETE THIS CALL. Run `npm run setup-db` manually once during deployment.
      // await this.initializeDatabase();
      // ----------------------------------------------------

      // Health check services
      await this.performHealthChecks();

      // ... rest of the method
```

---

### Step 2: Fix Code Correctness and Bugs

These are logical errors in your code that will cause incorrect behavior or crashes.

#### 2.1. Remove Reference to Non-Existent Table

- **Problem:** The `getWeeklyStats` method in `src/services/matching.ts` queries a table named `helper_suggestions`. This table does not exist in the schema and is not used anywhere else.
- **Explanation:** This is dead code that will crash if ever called.
- **Fix:** Remove the query and the logic related to `helper_suggestions`.

**Action:** In `src/services/matching.ts`, modify `getWeeklyStats` to remove the problematic query.

```typescript
// src/services/matching.ts

// ... in getWeeklyStats()

// ... (other queries are fine)

// Get average match scores for this week's suggestions
// THIS QUERY WILL FAIL. The `helper_suggestions` table is not defined.
/*
      const avgScoreResult = await db.query(`
        SELECT AVG(similarity_score) as avg_score 
        FROM helper_suggestions hs 
        JOIN weekly_needs wn ON hs.need_id = wn.id 
        WHERE wn.week_start = $1
      `, [weekStart]);
      */

// ...

return {
  totalNeeds: parseInt(needsResult.rows[0].count),
  totalHelpers: parseInt(helpersResult.rows[0].count),
  averageMatchScore: 0, // Set to 0 since we can't calculate it
  topSkills: topSkillsResult.rows,
};
```

#### 2.2. Make Health Checks Cheaper and Safer

- **Problem:** The `healthCheck` in `src/lib/openai.ts` makes a real, paid API call to OpenAI during development startup.
- **Explanation:** This is unnecessary, costs money, and can fail due to network issues, preventing your app from starting. A health check should be lightweight.
- **Fix:** Simplify the health check to only verify that the API key is present.

**Action:** Replace the `healthCheck` method in `src/lib/openai.ts` with this:

```typescript
// src/lib/openai.ts

  async healthCheck(): Promise<boolean> {
    // A simple, no-cost check is to see if the API key is configured.
    const isConfigured = !!this.openai.apiKey;
    if (!isConfigured) {
        console.error('OpenAI health check failed: API key is missing.');
    }
    return isConfigured;
  }
```

---

### Step 3: Simplify and Clean the Code

This section addresses areas where the code is overly complex, redundant, or not following best practices.

#### 3.1. Remove Redundant Modal-Opening Code

- **Problem:** In `src/app.ts`, the code to open the "need help" modal is duplicated in two action handlers: `app.action('open_need_modal', ...)` and `app.action('find_helpers', ...)`.
- **Explanation:** Duplicated code is harder to maintain. If you want to change the modal, you have to remember to change it in two places.
- **Fix:** Create a single helper function and have both actions call it.

**Action:** In `src/app.ts`, create a helper function and refactor the actions.

```typescript
// src/app.ts
import {
  App,
  SayFn,
  AllMiddlewareArgs,
  SlackActionMiddlewareArgs,
  BlockAction,
} from "@slack/bolt";
// ... other imports

// Helper function to open the modal
const openNeedHelpModal = async (client: any, triggerId: string) => {
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "need_help_modal",
      title: { type: "plain_text", text: "What do you need help with?" },
      submit: { type: "plain_text", text: "Find Helpers" },
      blocks: [
        {
          type: "input",
          block_id: "need_input",
          element: {
            type: "plain_text_input",
            action_id: "need_text",
            multiline: true,
            placeholder: {
              type: "plain_text",
              text: 'e.g., "Setting up React testing with Jest", "Optimizing PostgreSQL queries", etc.',
            },
          },
          label: { type: "plain_text", text: "Your need" },
        },
      ],
    },
  });
};

// Refactored action handlers
app.action("open_need_modal", async ({ ack, body, client }) => {
  await ack();
  try {
    await openNeedHelpModal(client, (body as BlockAction).trigger_id);
  } catch (error) {
    await errorHandler.handle(error, "open_need_modal", {
      userId: body.user.id,
    });
  }
});

app.action("find_helpers", async ({ ack, body, client }) => {
  await ack();
  try {
    await openNeedHelpModal(client, (body as BlockAction).trigger_id);
  } catch (error) {
    await errorHandler.handle(error, "find_helpers", { userId: body.user.id });
  }
});
```

#### 3.2. Simplify the Weekly Prompt Job

- **Problem:** `src/jobs/weekly-prompt.ts` creates an entire `new App(...)` instance just to send DMs.
- **Explanation:** This is overkill. The job only needs a Slack API client, not a full Bolt app instance with listeners and middleware.
- **Fix:** Use Slack's `WebClient` directly. It's lighter and more direct.

**Action:** Modify `src/jobs/weekly-prompt.ts`.

```typescript
// src/jobs/weekly-prompt.ts
import { config } from "dotenv";
// import { App } from '@slack/bolt'; // <-- REMOVE THIS
import { WebClient } from "@slack/web-api"; // <-- ADD THIS
import { db } from "../lib/database";
import { errorHandler } from "../utils/errorHandler";

config();

async function sendWeeklyPrompts() {
  console.log("Starting weekly prompt job...");

  // Create a simple WebClient instance
  const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN!);

  try {
    // ...
    for (const user of enabledUsers) {
      try {
        // Open DM channel with user
        const dmResponse = await slackClient.conversations.open({
          users: user.slack_id,
        });

        // ...

        // Send weekly prompt message
        await slackClient.chat.postMessage({
          channel: (dmResponse.channel as any)?.id || "",
          // ... rest of the message
        });

        // ...
      } catch (userError) {
        // ...
      }
    }
    // ...
  } catch (error) {
    // ...
  }
}
// ...
```

#### 3.3. Clean Up Dependencies

- **Problem:** `typescript` and `ts-node` are listed in `dependencies` in `package.json`.
- **Explanation:** These are tools used for development and building, not for running the final compiled JavaScript code. They should be in `devDependencies`. This keeps your production `node_modules` folder smaller and cleaner.
- **Fix:** Move them to `devDependencies`.

**Action:** In `package.json`, move the two lines.

```json
// package.json

"devDependencies": {
  "@types/node": "^24.2.0",
  "@types/pg": "^8.15.5",
  "ts-node": "^10.9.2",      // <-- MOVE HERE
  "typescript": "^5.9.2"   // <-- MOVE HERE
},
"dependencies": {
  "@slack/bolt": "^4.4.0",
  "bree": "^9.2.4",
  "dotenv": "^17.2.1",
  "fast-csv": "^5.0.5",
  "openai": "^5.11.0",
  "pg": "^8.16.3"
  // ts-node and typescript removed from here
},
```

---

### Final Plan of Attack

To get your app deployed successfully, follow these steps in order:

1.  **Create `database/schema.sql`:** Add the file with the SQL content provided above. This is the most critical fix.
2.  **Simplify `src/lib/database.ts`:** Replace the constructor with the simpler version.
3.  **Modify `src/server.ts`:** Remove the `await this.initializeDatabase()` call from the `start()` method.
4.  **Fix `src/services/matching.ts`:** Comment out or remove the failing query in `getWeeklyStats`.
5.  **Deploy:** Push your code. Your DigitalOcean deployment should now succeed.
6.  **Run Setup Scripts:** After the first successful deployment, manually run your setup scripts via the DigitalOcean console:
    - `npm run setup-db`
    - `npm run seed-skills -- seed-sample` (Note the `--` which is required to pass arguments to an npm script).
7.  **Clean Up (Optional but Recommended):** Apply the other simplification fixes (refactoring modals, simplifying the weekly job, moving dev dependencies) to make your codebase easier to maintain.
