import { Client, Pool } from "pg";
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

  // Person management methods
  async createPerson(slackId: string, displayName: string): Promise<void> {
    try {
      await this.query(
        "INSERT INTO people (slack_id, display_name) VALUES ($1, $2) ON CONFLICT (slack_id) DO UPDATE SET display_name = $2, updated_at = CURRENT_TIMESTAMP",
        [slackId, displayName]
      );
    } catch (error: any) {
      // If the table doesn't exist, try to initialize the schema
      if (error.message?.includes('relation "people" does not exist')) {
        console.log("⚠️ People table doesn't exist, initializing database schema...");
        await this.initializeSchema();
        // Retry the query
        await this.query(
          "INSERT INTO people (slack_id, display_name) VALUES ($1, $2) ON CONFLICT (slack_id) DO UPDATE SET display_name = $2, updated_at = CURRENT_TIMESTAMP",
          [slackId, displayName]
        );
      } else {
        throw error;
      }
    }
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

  async getAllSkills(): Promise<any[]> {
    const result = await this.query("SELECT * FROM skills ORDER BY skill");
    return result.rows;
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
      `SELECT s.id, s.skill 
       FROM skills s 
       JOIN person_skills ps ON s.id = ps.skill_id 
       WHERE ps.slack_id = $1
       ORDER BY s.skill`,
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

  async getWeeklyNeeds(weekStart: string): Promise<any[]> {
    const result = await this.query(
      `SELECT wn.*, p.display_name 
       FROM weekly_needs wn
       JOIN people p ON wn.slack_id = p.slack_id
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
      `SELECT p.slack_id, p.display_name,
              p.expertise, p.projects, p.offers,
              s.skill,
              1 - (s.embedding <=> $1::vector) AS score
       FROM skills s
       JOIN person_skills ps ON s.id = ps.skill_id
       JOIN people p ON ps.slack_id = p.slack_id
       WHERE p.enabled = TRUE 
         AND s.embedding IS NOT NULL
       ORDER BY score DESC
       LIMIT $2`,
      [`[${needEmbedding.join(",")}]`, limit]
    );
    return result.rows;
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
