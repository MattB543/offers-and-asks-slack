import { Client, Pool } from "pg";
import * as fs from "fs";
import * as path from "path";

export class Database {
  private pool: Pool;

  constructor() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error("DATABASE_URL environment variable is not set.");
    }

    const connectionString = `${dbUrl}?sslmode=no-verify`;

    this.pool = new Pool({
      connectionString: connectionString,
    });
  }

  async query(text: string, params?: any[]): Promise<any> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(text, params);
      return result;
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
    } catch (error) {
      console.error("Error initializing database schema:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
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
