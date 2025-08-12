import { Pool, PoolClient } from "pg";
import { config } from "dotenv";
config();
import * as fs from "fs";
import * as path from "path";

export class Database {
  private pool: Pool;

  constructor() {
    console.log("🔧 Database constructor starting...");

    let dbUrl = process.env.DATABASE_URL;
    console.log("📊 DATABASE_URL exists:", !!dbUrl);
    console.log("📊 Original DATABASE_URL:", dbUrl?.substring(0, 50) + "...");

    if (!dbUrl) {
      throw new Error("DATABASE_URL environment variable is not set.");
    }

    // Check if this is a DigitalOcean database
    const isDigitalOcean = dbUrl.includes("ondigitalocean.com");
    console.log("📊 Is DigitalOcean database:", isDigitalOcean);
    console.log("📊 NODE_ENV:", process.env.NODE_ENV);

    // IMPORTANT: Remove any existing SSL params from the connection string
    // because we'll handle SSL via the config object
    if (dbUrl.includes("?sslmode=")) {
      console.log("⚠️ Removing sslmode from DATABASE_URL to avoid conflicts");
      dbUrl = dbUrl.split("?")[0];
      console.log("📊 Cleaned DATABASE_URL:", dbUrl?.substring(0, 50) + "...");
    }

    // For DigitalOcean, use a specific SSL configuration
    let poolConfig: any;

    if (isDigitalOcean || process.env.NODE_ENV === "production") {
      console.log("🔐 Using DigitalOcean/Production SSL configuration");

      // Use the connection string with sslmode parameter instead of ssl object
      // This is more reliable for DigitalOcean
      dbUrl = dbUrl + "?sslmode=no-verify";
      console.log("📊 Added sslmode=no-verify to connection string");

      poolConfig = {
        connectionString: dbUrl,
        // Don't add ssl object when using sslmode in connection string
      };
    } else {
      console.log("🔐 Development mode - no SSL");
      poolConfig = {
        connectionString: dbUrl,
      };
    }

    console.log(
      "📊 Final connection string includes sslmode:",
      dbUrl.includes("sslmode")
    );
    console.log("📊 Pool config has ssl object:", !!poolConfig.ssl);

    try {
      this.pool = new Pool(poolConfig);
      console.log("✅ Pool created successfully");

      // Add error listener
      this.pool.on("error", (err) => {
        console.error("🚨 Pool error:", err.message);
      });
    } catch (error) {
      console.error("❌ Failed to create pool:", error);
      throw error;
    }
  }

  async query(text: string, params?: any[]): Promise<any> {
    const client = await this.pool.connect();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  }

  async runInTransaction<T>(
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("❌ Transaction rollback failed:", rollbackError);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async initializeSchema(): Promise<void> {
    const schemaPath = path.join(__dirname, "../../database/schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf8");

    const client = await this.pool.connect();
    try {
      await client.query(schema);
      console.log("Database schema initialized successfully");
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ============ Slack message embeddings ============
  async upsertSlackMessageEmbedding(
    messageId: number,
    embedding: number[]
  ): Promise<void> {
    await this.query(
      `UPDATE slack_message SET embedding = $1::vector WHERE id = $2`,
      [`[${embedding.join(",")}]`, messageId]
    );
  }

  async batchUpdateSlackMessageEmbeddings(
    pairs: Array<{ id: number; embedding: number[] }>
  ): Promise<void> {
    if (pairs.length === 0) return;
    // Filter out empty vectors to avoid pgvector errors
    const valid = pairs.filter(
      (p) => Array.isArray(p.embedding) && p.embedding.length > 0
    );
    if (valid.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const { id, embedding } of valid) {
        await client.query(
          `UPDATE slack_message SET embedding = $1::vector WHERE id = $2`,
          [`[${embedding.join(",")}]`, id]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw e;
    } finally {
      client.release();
    }
  }

  async fetchSlackMessagesNeedingEmbedding(
    limit: number
  ): Promise<Array<{ id: number; text: string }>> {
    const res = await this.query(
      `SELECT id, text
       FROM slack_message
       WHERE text IS NOT NULL
         AND COALESCE(subtype,'') NOT IN (
           'channel_join','channel_leave','bot_message','message_changed','message_deleted',
           'thread_broadcast','file_share','channel_topic','channel_purpose','channel_name',
           'channel_archive','channel_unarchive','group_join','group_leave'
         )
         AND text ~ '\\S'
         AND embedding IS NULL
       ORDER BY id ASC
       LIMIT $1`,
      [limit]
    );
    return res.rows as Array<{ id: number; text: string }>;
  }

  // Person management methods
  async createPerson(userId: string, displayName: string): Promise<void> {
    try {
      // Insert or update using slack_user_id as the proper identifier
      await this.query(
        `INSERT INTO people (user_id, slack_user_id, display_name) 
         VALUES ($1, $1, $2) 
         ON CONFLICT (user_id) DO UPDATE SET 
           slack_user_id = $1,
           display_name = $2, 
           updated_at = CURRENT_TIMESTAMP`,
        [userId, displayName]
      );
    } catch (error: any) {
      // If the table doesn't exist, try to initialize the schema
      if (error.message?.includes('relation "people" does not exist')) {
        console.log(
          "⚠️ People table doesn't exist, initializing database schema..."
        );
        await this.initializeSchema();
        // Retry the query
        await this.query(
          `INSERT INTO people (user_id, slack_user_id, display_name) 
           VALUES ($1, $1, $2) 
           ON CONFLICT (user_id) DO UPDATE SET 
             slack_user_id = $1,
             display_name = $2, 
             updated_at = CURRENT_TIMESTAMP`,
          [userId, displayName]
        );
      } else {
        throw error;
      }
    }
  }

  async getPerson(userId: string): Promise<any> {
    // First try by slack_user_id, then fallback to user_id
    let result = await this.query(
      `SELECT * FROM people
       WHERE slack_user_id = $1
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      result = await this.query("SELECT * FROM people WHERE user_id = $1", [
        userId,
      ]);
    }

    return result.rows[0];
  }

  async getAllEnabledPeople(): Promise<any[]> {
    const result = await this.query(
      "SELECT * FROM people WHERE enabled = TRUE"
    );
    return result.rows;
  }

  async togglePersonEnabled(userId: string, enabled: boolean): Promise<void> {
    await this.query("UPDATE people SET enabled = $2 WHERE user_id = $1", [
      userId,
      enabled,
    ]);
  }

  // Skill management methods
  async createSkill(skill: string): Promise<number> {
    const result = await this.query(
      "INSERT INTO skills (skill) VALUES ($1) ON CONFLICT (skill) DO UPDATE SET skill = $1 RETURNING id",
      [skill]
    );
    return result.rows[0].id;
  }

  async updateSkillEmbedding(
    skillId: number,
    embedding: number[]
  ): Promise<void> {
    await this.query("UPDATE skills SET embedding = $1::vector WHERE id = $2", [
      `[${embedding.join(",")}]`,
      skillId,
    ]);
  }

  async getSkillByText(skill: string): Promise<any> {
    const result = await this.query("SELECT * FROM skills WHERE skill = $1", [
      skill,
    ]);
    return result.rows[0];
  }

  async getAllSkills(): Promise<any[]> {
    const result = await this.query("SELECT * FROM skills ORDER BY skill");
    return result.rows;
  }

  async getAllSkillNames(): Promise<string[]> {
    const result = await this.query("SELECT skill FROM skills ORDER BY skill");
    return result.rows.map((r: any) => r.skill as string);
  }

  // Person-skill relationship methods
  async addPersonSkill(userId: string, skillId: number): Promise<void> {
    // Find the person's internal user_id using their slack_user_id
    const person = await this.getPerson(userId);
    if (!person) {
      throw new Error(`Person not found for user_id: ${userId}`);
    }

    await this.query(
      "INSERT INTO person_skills (user_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [person.user_id, skillId]
    );
  }

  async clearPersonSkills(userId: string): Promise<void> {
    // Resolve to internal person id using either slack_user_id or user_id
    const person = await this.getPerson(userId);
    if (!person) {
      throw new Error(`Person not found for user_id: ${userId}`);
    }
    await this.query("DELETE FROM person_skills WHERE user_id = $1", [
      person.user_id,
    ]);
  }

  async removePersonSkill(userId: string, skillId: number): Promise<void> {
    // Find the person's internal user_id using their slack_user_id
    const person = await this.getPerson(userId);
    if (!person) {
      throw new Error(`Person not found for user_id: ${userId}`);
    }

    await this.query(
      "DELETE FROM person_skills WHERE user_id = $1 AND skill_id = $2",
      [person.user_id, skillId]
    );
  }

  async getPersonSkills(userId: string): Promise<any[]> {
    // First try to find by slack_user_id, then fallback to user_id
    let result = await this.query(
      `SELECT s.id, s.skill 
         FROM skills s 
         JOIN person_skills ps ON s.id = ps.skill_id 
         JOIN (
           SELECT DISTINCT ON (user_id) user_id
           FROM people
           WHERE slack_user_id = $1
           ORDER BY user_id, updated_at DESC NULLS LAST
         ) p ON ps.user_id = p.user_id
         ORDER BY s.skill`,
      [userId]
    );

    // If no results found by slack_user_id, try by user_id (backward compatibility)
    if (result.rows.length === 0) {
      result = await this.query(
        `SELECT s.id, s.skill 
         FROM skills s 
         JOIN person_skills ps ON s.id = ps.skill_id 
         WHERE ps.user_id = $1
         ORDER BY s.skill`,
        [userId]
      );
    }

    return result.rows;
  }

  // Weekly needs methods
  async createWeeklyNeed(
    userId: string,
    needText: string,
    needEmbedding: number[],
    weekStart: string
  ): Promise<number> {
    const result = await this.query(
      "INSERT INTO weekly_needs (user_id, need_text, need_embedding, week_start) VALUES ($1, $2, $3::vector, $4) RETURNING id",
      [userId, needText, `[${needEmbedding.join(",")}]`, weekStart]
    );
    return result.rows[0].id;
  }

  async updateWeeklyNeedProcessing(
    needId: number,
    params: {
      skillsExtracted?: string[] | null;
      similarityCandidatesJson?: any | null;
      rerankedIds?: string[] | null;
      rerankedCandidatesJson?: any | null;
      processingMetadataJson?: any | null;
      error?: string | null;
    }
  ): Promise<void> {
    const {
      skillsExtracted = null,
      similarityCandidatesJson = null,
      rerankedIds = null,
      rerankedCandidatesJson = null,
      processingMetadataJson = null,
      error = null,
    } = params;

    await this.query(
      `UPDATE weekly_needs
       SET
         skills_extracted = COALESCE($2, skills_extracted),
         similarity_candidates = COALESCE($3::jsonb, similarity_candidates),
         reranked_ids = COALESCE($4, reranked_ids),
         reranked_candidates = COALESCE($5::jsonb, reranked_candidates),
         processing_metadata = COALESCE($6::jsonb, processing_metadata),
         error = COALESCE($7, error)
       WHERE id = $1`,
      [
        needId,
        skillsExtracted,
        similarityCandidatesJson
          ? JSON.stringify(similarityCandidatesJson)
          : null,
        rerankedIds,
        rerankedCandidatesJson ? JSON.stringify(rerankedCandidatesJson) : null,
        processingMetadataJson ? JSON.stringify(processingMetadataJson) : null,
        error,
      ]
    );
  }

  async getWeeklyNeeds(weekStart: string): Promise<any[]> {
    const result = await this.query(
      `SELECT wn.*, p.display_name 
       FROM weekly_needs wn
       JOIN people p ON wn.user_id = p.user_id
       WHERE wn.week_start = $1
       ORDER BY wn.created_at DESC`,
      [weekStart]
    );
    return result.rows;
  }

  // Helper matching using vector similarity
  async findSimilarHelpers(
    needEmbedding: number[],
    limit: number = 20
  ): Promise<any[]> {
    const result = await this.query(
      `SELECT p.user_id, p.slack_user_id, p.display_name,
              p.expertise, p.projects, p.offers,
              s.skill,
              1 - (s.embedding <=> $1::vector) AS score
       FROM skills s
       JOIN person_skills ps ON s.id = ps.skill_id
       JOIN people p ON ps.user_id = p.user_id
       WHERE p.enabled = TRUE 
         AND s.embedding IS NOT NULL
       ORDER BY score DESC
       LIMIT $2`,
      [`[${needEmbedding.join(",")}]`, limit]
    );
    return result.rows;
  }

  // Fetch channels where any of the provided Slack user IDs are members,
  // and include human-readable member names for each channel
  async getChannelsByMemberSlackIds(memberSlackIds: string[]): Promise<
    Array<{
      channel_id: string;
      channel_name: string | null;
      summary: string | null;
      member_ids: string[];
      member_names: string[];
    }>
  > {
    if (!memberSlackIds || memberSlackIds.length === 0) return [];

    const result = await this.query(
      `SELECT
         scp.channel_id,
         scp.channel_name,
         scp.summary,
         scp.member_ids,
         ARRAY_AGG(DISTINCT COALESCE(p.display_name, m)) AS member_names
       FROM slack_channel_profiles scp
       LEFT JOIN LATERAL unnest(scp.member_ids) AS m ON TRUE
       LEFT JOIN people p ON p.slack_user_id = m
       WHERE scp.member_ids && $1::text[]
       GROUP BY scp.channel_id, scp.channel_name, scp.summary, scp.member_ids
       ORDER BY scp.channel_name NULLS LAST`,
      [memberSlackIds]
    );

    return result.rows;
  }

  // Fetch recent plaintext messages authored by a given Slack user ID from stored exports
  // Enhancements:
  // - Exclude channel join notifications (subtype = 'channel_join')
  // - Prefix each message with the channel name (e.g., "#channel_name: ...")
  // - If a message is part of a thread, include full thread context inline
  // - Return the most recent `limit` user-authored messages (default 100)
  async getUserMessages(
    slackUserId: string,
    limit: number = 100
  ): Promise<string[]> {
    if (!slackUserId) return [];

    // Step 1: Get the most recent authored messages by this user (excluding channel joins)
    const authored = await this.query(
      `SELECT id, channel_id, channel_name, ts, text, subtype, thread_ts, is_reply, parent_ts
       FROM slack_message
       WHERE user_id = $1
         AND text IS NOT NULL
         AND COALESCE(subtype,'') NOT IN (
           'channel_join','channel_leave','bot_message','message_changed','message_deleted',
           'thread_broadcast','file_share','channel_topic','channel_purpose','channel_name',
           'channel_archive','channel_unarchive','group_join','group_leave'
         )
       ORDER BY id DESC
       LIMIT $2`,
      [slackUserId, limit]
    );

    const sanitize = (t: string | null | undefined): string =>
      (t || "").replace(/[\s\u200B]+/g, " ").trim();

    const formatChannel = (name: string | null | undefined): string => {
      const n = (name || "").toString().trim();
      if (!n) return "#unknown";
      const withoutHash = n.replace(/^#/, "");
      return `#${withoutHash}`;
    };

    const outputs: string[] = [];
    for (const row of authored.rows) {
      const channelId: string = row.channel_id;
      const channelName: string | null = row.channel_name;
      const thisTs: string = row.ts;
      const rootTs: string = row.thread_ts || row.parent_ts || row.ts;

      // Step 2: Load full thread context for this message's thread (root, replies)
      let threadRows: Array<{
        ts: string;
        text: string | null;
      }>; // minimal projection for formatting
      try {
        const threadRes = await this.query(
          `SELECT ts, text
           FROM slack_message
           WHERE channel_id = $1
             AND text IS NOT NULL
              AND COALESCE(subtype,'') NOT IN (
                'channel_join','channel_leave','bot_message','message_changed','message_deleted',
                'thread_broadcast','file_share','channel_topic','channel_purpose','channel_name',
                'channel_archive','channel_unarchive','group_join','group_leave'
              )
             AND (
               ts = $2 OR parent_ts = $2 OR thread_ts = $2
             )
           ORDER BY ts ASC, id ASC`,
          [channelId, rootTs]
        );
        threadRows = threadRes.rows as Array<{
          ts: string;
          text: string | null;
        }>;
      } catch {
        // Fallback: if thread query fails, just use the single message text
        threadRows = [{ ts: thisTs, text: row.text }];
      }

      // Step 3: Build a single-line context string
      // Format: "#channel_name: <root> -> <reply1> -> <reply2>"
      // If no replies, it's just "#channel_name: <text>"
      const channelPrefix = formatChannel(channelName);

      // Ensure root message is first, followed by others in order
      let rootText = "";
      const otherTexts: string[] = [];
      for (const m of threadRows) {
        const text = sanitize(m.text);
        if (!text) continue;
        if (m.ts === rootTs && !rootText) {
          rootText = text;
        } else {
          otherTexts.push(text);
        }
      }

      // If root not found (edge cases), fall back to this message's text
      if (!rootText) rootText = sanitize(row.text);

      const joined =
        otherTexts.length > 0
          ? `${rootText} -> ${otherTexts.join(" -> ")}`
          : rootText;

      const line = `${channelPrefix}: ${joined}`.trim();
      if (line.length > 0) outputs.push(line);
    }

    return outputs;
  }

  /**
   * Fetch ALL authored messages for a Slack user, deduplicated by thread root,
   * and rendered with inline thread context, most recent threads first.
   */
  async getUserMessagesAll(slackUserId: string): Promise<string[]> {
    if (!slackUserId) return [];

    // Step 1: Distinct threads authored by user (root ts per thread), newest first by max(id)
    const threads = await this.query(
      `WITH authored AS (
         SELECT id,
                channel_id,
                channel_name,
                COALESCE(thread_ts, parent_ts, ts) AS root_ts
         FROM slack_message
         WHERE user_id = $1
           AND text IS NOT NULL
           AND COALESCE(subtype,'') NOT IN (
             'channel_join','channel_leave','bot_message','message_changed','message_deleted',
             'thread_broadcast','file_share','channel_topic','channel_purpose','channel_name',
             'channel_archive','channel_unarchive','group_join','group_leave'
           )
       )
       SELECT a.channel_id,
              max(a.channel_name) AS channel_name,
              a.root_ts,
              max(a.id) AS latest_id
       FROM authored a
       GROUP BY a.channel_id, a.root_ts
       ORDER BY latest_id DESC`,
      [slackUserId]
    );

    const sanitize = (t: string | null | undefined): string =>
      (t || "")
        .replace(/\s+/g, " ")
        .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
        .trim();

    const formatChannel = (name: string | null | undefined): string => {
      const n = (name || "").toString().trim();
      if (!n) return "#unknown";
      const withoutHash = n.replace(/^#/, "");
      return `#${withoutHash}`;
    };

    const outputs: string[] = [];

    // Cache display names for mentions
    const nameCache = new Map<string, string>();
    const getDisplayName = async (
      sid: string | null | undefined
    ): Promise<string | null> => {
      if (!sid) return null;
      if (nameCache.has(sid)) return nameCache.get(sid)!;
      const res = await this.query(
        `SELECT display_name FROM people WHERE slack_user_id = $1 LIMIT 1`,
        [sid]
      );
      const n = (res.rows[0]?.display_name as string | undefined) || null;
      if (n) nameCache.set(sid, n);
      return n;
    };
    const mentionFor = async (
      sid: string | null | undefined
    ): Promise<string> => {
      if (!sid) return "@unknown";
      const dn = await getDisplayName(sid);
      if (!dn) return `<@${sid}>`;
      const handle = dn.trim().replace(/\s+/g, "_");
      return `@${handle}`;
    };

    for (const row of threads.rows as Array<{
      channel_id: string;
      channel_name: string | null;
      root_ts: string;
    }>) {
      const channelId = row.channel_id;
      const channelName = row.channel_name;
      const rootTs = row.root_ts;

      // Load full thread context once per root
      let threadRows: Array<{
        ts: string;
        text: string | null;
        user_id: string | null;
      }> = [];
      try {
        const threadRes = await this.query(
          `SELECT ts, text, user_id
           FROM slack_message
           WHERE channel_id = $1
             AND text IS NOT NULL
              AND COALESCE(subtype,'') NOT IN (
                'channel_join','channel_leave','bot_message','message_changed','message_deleted',
                'thread_broadcast','file_share','channel_topic','channel_purpose','channel_name',
                'channel_archive','channel_unarchive','group_join','group_leave'
              )
             AND (
               ts = $2 OR parent_ts = $2 OR thread_ts = $2
             )
           ORDER BY ts ASC, id ASC`,
          [channelId, rootTs]
        );
        threadRows = threadRes.rows as Array<{
          ts: string;
          text: string | null;
          user_id: string | null;
        }>;
      } catch {
        // Ignore threads we can't load fully
        continue;
      }

      const channelPrefix = formatChannel(channelName);
      const root = threadRows.find((m) => m.ts === rootTs) || threadRows[0];
      if (!root) continue;
      const rootText = sanitize(root.text);
      if (!rootText) continue;

      // Replies authored by the target user in this thread
      const myReplies = threadRows.filter(
        (m) => m.user_id === slackUserId && m.ts !== rootTs
      );

      let line = "";
      if (root.user_id === slackUserId) {
        // User authored the root; include only the root line
        const me = await mentionFor(slackUserId);
        line = `${channelPrefix}: ${me}: ${rootText}`;
      } else if (myReplies.length > 0) {
        // User replied in this thread; show root author and user's reply chain
        const rootAuthor = await mentionFor(root.user_id);
        const me = await mentionFor(slackUserId);
        const replyText = myReplies
          .map((r) => sanitize(r.text))
          .filter((t) => t.length > 0)
          .join(" | ");
        line = `${channelPrefix}: ${rootAuthor}: ${rootText} -> ${me} reply: ${replyText}`;
      } else {
        // No authored content by user; skip this thread
        continue;
      }

      line = line.trim();
      if (line.length > 0) outputs.push(line);
    }

    // Final de-dup pass in case different channels share identical content lines
    const seen = new Set<string>();
    const unique = outputs.filter((l) => {
      if (seen.has(l)) return false;
      seen.add(l);
      return true;
    });
    return unique;
  }

  // Health check
  async healthCheck(): Promise<boolean> {
    try {
      await this.query("SELECT 1");
      return true;
    } catch (error) {
      console.error("Database health check failed:", error);
      return false;
    }
  }
}

export const db = new Database();
