import { Client, Pool } from "pg";
import * as fs from "fs";
import * as path from "path";

export class Database {
  private pool: Pool;

  constructor() {
    console.log("🔧 Database constructor starting...");

    const dbUrl = process.env.DATABASE_URL;
    console.log("📊 DATABASE_URL exists:", !!dbUrl);
    console.log("📊 DATABASE_URL length:", dbUrl?.length || 0);
    console.log(
      "📊 DATABASE_URL starts with:",
      dbUrl?.substring(0, 20) + "..."
    );

    if (!dbUrl) {
      throw new Error("DATABASE_URL environment variable is not set.");
    }

    // Parse the URL to see what we're connecting to
    try {
      const urlParts = dbUrl.match(
        /postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/
      );
      if (urlParts) {
        console.log("📊 DB Host:", urlParts[3]);
        console.log("📊 DB Port:", urlParts[4]);
        console.log("📊 DB Name:", urlParts[5]);
        console.log("📊 DB User:", urlParts[1]);
      }
    } catch (e) {
      console.log("⚠️ Could not parse DATABASE_URL");
    }

    console.log("📊 NODE_ENV:", process.env.NODE_ENV);
    console.log(
      "📊 NODE_ENV === 'production':",
      process.env.NODE_ENV === "production"
    );

    // Try different SSL configurations
    let sslConfig: any;

    // Check if we're in production
    const isProduction = process.env.NODE_ENV === "production";
    console.log("📊 isProduction:", isProduction);

    if (isProduction) {
      console.log("🔐 Setting up PRODUCTION SSL config");

      // For DigitalOcean, we need to handle their SSL differently
      // Try multiple approaches
      sslConfig = {
        rejectUnauthorized: false,
        require: true,
      };

      console.log("🔐 SSL Config being used:", JSON.stringify(sslConfig));
    } else {
      console.log("🔐 Setting up DEVELOPMENT SSL config (false)");
      sslConfig = false;
    }

    console.log("📊 Final SSL config type:", typeof sslConfig);
    console.log("📊 Final SSL config value:", JSON.stringify(sslConfig));

    // Create the pool with extensive logging
    const poolConfig = {
      connectionString: dbUrl,
      ssl: sslConfig,
    };

    console.log("📊 Creating Pool with config:");
    console.log(
      "  - connectionString length:",
      poolConfig.connectionString.length
    );
    console.log("  - ssl:", JSON.stringify(poolConfig.ssl));

    try {
      this.pool = new Pool(poolConfig);
      console.log("✅ Pool created successfully");

      // Add error listener to pool
      this.pool.on("error", (err) => {
        console.error("🚨 Unexpected pool error:", err);
      });

      this.pool.on("connect", () => {
        console.log("🔗 Pool client connected");
      });
    } catch (error) {
      console.error("❌ Failed to create pool:", error);
      throw error;
    }
  }

  async query(text: string, params?: any[]): Promise<any> {
    console.log("🔍 Attempting query:", text.substring(0, 50) + "...");
    console.log("🔍 Query params count:", params?.length || 0);

    let client;
    try {
      console.log("🔍 Getting client from pool...");
      client = await this.pool.connect();
      console.log("✅ Got client from pool");

      console.log("🔍 Executing query...");
      const result = await client.query(text, params);
      console.log("✅ Query executed successfully");
      console.log("🔍 Result rows:", result.rows?.length || 0);

      return result;
    } catch (error: any) {
      console.error("❌ Query failed:", error.message);
      console.error("❌ Error code:", error.code);
      console.error("❌ Error stack:", error.stack);
      throw error;
    } finally {
      if (client) {
        console.log("🔍 Releasing client back to pool");
        client.release();
      }
    }
  }

  async initializeSchema(): Promise<void> {
    console.log("📝 Initializing database schema...");
    const schemaPath = path.join(__dirname, "../../database/schema.sql");
    console.log("📝 Schema path:", schemaPath);
    console.log("📝 Schema file exists:", fs.existsSync(schemaPath));

    const schema = fs.readFileSync(schemaPath, "utf8");
    console.log("📝 Schema length:", schema.length);

    const client = await this.pool.connect();
    try {
      await client.query(schema);
      console.log("✅ Database schema initialized successfully");
    } catch (error) {
      console.error("❌ Error initializing database schema:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    console.log("🔒 Closing database pool...");
    await this.pool.end();
    console.log("✅ Database pool closed");
  }

  // Person management methods
  async createPerson(slackId: string, displayName: string): Promise<void> {
    await this.query(
      "INSERT INTO people (slack_id, display_name) VALUES ($1, $2) ON CONFLICT (slack_id) DO UPDATE SET display_name = $2, updated_at = CURRENT_TIMESTAMP",
      [slackId, displayName]
    );
  }

  async getPerson(slackId: string): Promise<any> {
    const result = await this.query(
      "SELECT * FROM people WHERE slack_id = $1",
      [slackId]
    );
    return result.rows[0];
  }

  async getAllEnabledPeople(): Promise<any[]> {
    const result = await this.query(
      "SELECT * FROM people WHERE enabled = TRUE"
    );
    return result.rows;
  }

  async togglePersonEnabled(slackId: string, enabled: boolean): Promise<void> {
    await this.query("UPDATE people SET enabled = $2 WHERE slack_id = $1", [
      slackId,
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

  // Person-skill relationship methods
  async addPersonSkill(slackId: string, skillId: number): Promise<void> {
    await this.query(
      "INSERT INTO person_skills (slack_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [slackId, skillId]
    );
  }

  async removePersonSkill(slackId: string, skillId: number): Promise<void> {
    await this.query(
      "DELETE FROM person_skills WHERE slack_id = $1 AND skill_id = $2",
      [slackId, skillId]
    );
  }

  async getPersonSkills(slackId: string): Promise<any[]> {
    const result = await this.query(
      `
      SELECT s.id, s.skill 
      FROM skills s 
      JOIN person_skills ps ON s.id = ps.skill_id 
      WHERE ps.slack_id = $1
    `,
      [slackId]
    );
    return result.rows;
  }

  // Weekly needs methods
  async createWeeklyNeed(
    slackId: string,
    needText: string,
    needEmbedding: number[],
    weekStart: string
  ): Promise<number> {
    const result = await this.query(
      "INSERT INTO weekly_needs (slack_id, need_text, need_embedding, week_start) VALUES ($1, $2, $3::vector, $4) RETURNING id",
      [slackId, needText, `[${needEmbedding.join(",")}]`, weekStart]
    );
    return result.rows[0].id;
  }

  // Helper matching method using cosine similarity
  async findSimilarHelpers(
    needEmbedding: number[],
    limit: number = 20
  ): Promise<any[]> {
    const result = await this.query(
      `
      SELECT p.slack_id, p.display_name,
             s.skill,
             1 - (s.embedding <=> $1::vector) AS score
      FROM skills s
      JOIN person_skills ps ON s.id = ps.skill_id
      JOIN people p ON ps.slack_id = p.slack_id
      WHERE p.enabled = TRUE
      ORDER BY score DESC
      LIMIT $2
    `,
      [`[${needEmbedding.join(",")}]`, limit]
    );
    return result.rows;
  }

  // Health check
  async healthCheck(): Promise<boolean> {
    console.log("🏥 Starting database health check...");
    try {
      console.log("🏥 Attempting SELECT 1 query...");
      await this.query("SELECT 1");
      console.log("✅ Database health check PASSED");
      return true;
    } catch (error: any) {
      console.error("❌ Database health check FAILED");
      console.error("❌ Health check error:", error.message);
      console.error("❌ Health check error code:", error.code);
      console.error("❌ Health check error stack:", error.stack);
      return false;
    }
  }
}

console.log("📦 Creating database instance...");
export const db = new Database();
console.log("📦 Database instance created");
