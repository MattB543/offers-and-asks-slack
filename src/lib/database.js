"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = exports.Database = void 0;
const pg_1 = require("pg");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class Database {
    pool;
    constructor() {
        this.pool = new pg_1.Pool({
            connectionString: process.env.DATABASE_URL || undefined,
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || '5432'),
            database: process.env.DB_NAME || 'helper_matcher',
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });
    }
    async query(text, params) {
        const client = await this.pool.connect();
        try {
            const result = await client.query(text, params);
            return result;
        }
        finally {
            client.release();
        }
    }
    async initializeSchema() {
        const schemaPath = path.join(__dirname, '../../database/schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        const client = await this.pool.connect();
        try {
            await client.query(schema);
            console.log('Database schema initialized successfully');
        }
        catch (error) {
            console.error('Error initializing database schema:', error);
            throw error;
        }
        finally {
            client.release();
        }
    }
    async close() {
        await this.pool.end();
    }
    // Person management methods
    async createPerson(slackId, displayName) {
        await this.query('INSERT INTO people (slack_id, display_name) VALUES ($1, $2) ON CONFLICT (slack_id) DO UPDATE SET display_name = $2, updated_at = CURRENT_TIMESTAMP', [slackId, displayName]);
    }
    async getPerson(slackId) {
        const result = await this.query('SELECT * FROM people WHERE slack_id = $1', [slackId]);
        return result.rows[0];
    }
    async getAllEnabledPeople() {
        const result = await this.query('SELECT * FROM people WHERE enabled = TRUE');
        return result.rows;
    }
    async togglePersonEnabled(slackId, enabled) {
        await this.query('UPDATE people SET enabled = $2 WHERE slack_id = $1', [slackId, enabled]);
    }
    // Skill management methods
    async createSkill(skill) {
        const result = await this.query('INSERT INTO skills (skill) VALUES ($1) ON CONFLICT (skill) DO UPDATE SET skill = $1 RETURNING id', [skill]);
        return result.rows[0].id;
    }
    async updateSkillEmbedding(skillId, embedding) {
        await this.query('UPDATE skills SET embedding = $1 WHERE id = $2', [JSON.stringify(embedding), skillId]);
    }
    async getSkillByText(skill) {
        const result = await this.query('SELECT * FROM skills WHERE skill = $1', [skill]);
        return result.rows[0];
    }
    // Person-skill relationship methods
    async addPersonSkill(slackId, skillId) {
        await this.query('INSERT INTO person_skills (slack_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [slackId, skillId]);
    }
    async removePersonSkill(slackId, skillId) {
        await this.query('DELETE FROM person_skills WHERE slack_id = $1 AND skill_id = $2', [slackId, skillId]);
    }
    async getPersonSkills(slackId) {
        const result = await this.query(`
      SELECT s.id, s.skill 
      FROM skills s 
      JOIN person_skills ps ON s.id = ps.skill_id 
      WHERE ps.slack_id = $1
    `, [slackId]);
        return result.rows;
    }
    // Weekly needs methods
    async createWeeklyNeed(slackId, needText, needEmbedding, weekStart) {
        const result = await this.query('INSERT INTO weekly_needs (slack_id, need_text, need_embedding, week_start) VALUES ($1, $2, $3, $4) RETURNING id', [slackId, needText, JSON.stringify(needEmbedding), weekStart]);
        return result.rows[0].id;
    }
    // Helper matching method using cosine similarity
    async findSimilarHelpers(needEmbedding, limit = 20) {
        const result = await this.query(`
      SELECT p.slack_id, p.display_name,
             s.skill,
             1 - (s.embedding <=> $1::vector) AS score
      FROM skills s
      JOIN person_skills ps ON s.id = ps.skill_id
      JOIN people p ON ps.slack_id = p.slack_id
      WHERE p.enabled = TRUE
      ORDER BY score DESC
      LIMIT $2
    `, [JSON.stringify(needEmbedding), limit]);
        return result.rows;
    }
    // Health check
    async healthCheck() {
        try {
            await this.query('SELECT 1');
            return true;
        }
        catch (error) {
            console.error('Database health check failed:', error);
            return false;
        }
    }
}
exports.Database = Database;
exports.db = new Database();
//# sourceMappingURL=database.js.map