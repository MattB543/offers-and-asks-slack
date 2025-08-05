import { db } from '../lib/database';
import { embeddingService } from '../lib/openai';

export interface Helper {
  id: string;
  name: string;
  skills: string[];
  score?: number;
}

export class HelperMatchingService {
  async findHelpers(needText: string, requesterId?: string, limit: number = 5): Promise<Helper[]> {
    try {
      // Generate embedding for the need
      const needEmbedding = await embeddingService.generateEmbedding(needText);
      
      // Store the need if requesterId is provided
      if (requesterId) {
        const weekStart = this.getWeekStart(new Date());
        await db.createWeeklyNeed(requesterId, needText, needEmbedding, weekStart);
      }
      
      // Find similar helpers using vector similarity
      const similarHelpers = await db.findSimilarHelpers(needEmbedding, 20);
      
      // Group by person and aggregate their top skills
      const helperMap = new Map<string, Helper>();
      
      for (const row of similarHelpers) {
        // Skip the requester from results
        if (requesterId && row.slack_id === requesterId) {
          continue;
        }
        
        let helper = helperMap.get(row.slack_id);
        if (!helper) {
          helper = {
            id: row.slack_id,
            name: row.display_name || 'Unknown',
            skills: [],
            score: row.score
          };
          helperMap.set(row.slack_id, helper);
        }
        
        // Add skill if not already present and we have room
        if (helper.skills.length < 3 && !helper.skills.includes(row.skill)) {
          helper.skills.push(row.skill);
        }
        
        // Update score to be the max score across all their skills
        if (row.score > (helper.score || 0)) {
          helper.score = row.score;
        }
      }
      
      // Convert to array and sort by score
      const helpers = Array.from(helperMap.values())
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, limit)
        .filter(helper => helper.skills.length > 0); // Only include helpers with relevant skills
      
      return helpers;
    } catch (error) {
      console.error('Error finding helpers:', error);
      throw new Error(`Failed to find helpers: ${error}`);
    }
  }

  async findHelpersForMultipleNeeds(needs: Array<{text: string, requesterId: string}>): Promise<Map<string, Helper[]>> {
    const results = new Map<string, Helper[]>();
    
    for (const need of needs) {
      try {
        const helpers = await this.findHelpers(need.text, need.requesterId);
        results.set(need.requesterId, helpers);
      } catch (error) {
        console.error(`Error finding helpers for ${need.requesterId}:`, error);
        results.set(need.requesterId, []);
      }
    }
    
    return results;
  }

  private getWeekStart(date: Date): string {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
    d.setDate(diff);
    return d.toISOString().split('T')[0]!; // YYYY-MM-DD format
  }

  async getWeeklyStats(): Promise<{
    totalNeeds: number;
    totalHelpers: number;
    averageMatchScore: number;
    topSkills: Array<{skill: string, count: number}>;
  }> {
    try {
      const weekStart = this.getWeekStart(new Date());
      
      // Get total needs for this week
      const needsResult = await db.query(
        'SELECT COUNT(*) as count FROM weekly_needs WHERE week_start = $1',
        [weekStart]
      );
      
      // Get total active helpers
      const helpersResult = await db.query(
        'SELECT COUNT(DISTINCT slack_id) as count FROM person_skills ps JOIN people p ON ps.slack_id = p.slack_id WHERE p.enabled = TRUE'
      );
      
      // Get average match scores for this week's suggestions
      // Note: helper_suggestions table functionality not yet implemented
      // const avgScoreResult = await db.query(`
      //   SELECT AVG(similarity_score) as avg_score 
      //   FROM helper_suggestions hs 
      //   JOIN weekly_needs wn ON hs.need_id = wn.id 
      //   WHERE wn.week_start = $1
      // `, [weekStart]);
      
      // Get top skills by usage
      const topSkillsResult = await db.query(`
        SELECT s.skill, COUNT(*) as count
        FROM person_skills ps
        JOIN skills s ON ps.skill_id = s.id
        JOIN people p ON ps.slack_id = p.slack_id
        WHERE p.enabled = TRUE
        GROUP BY s.skill
        ORDER BY count DESC
        LIMIT 10
      `);
      
      return {
        totalNeeds: parseInt(needsResult.rows[0].count),
        totalHelpers: parseInt(helpersResult.rows[0].count),
        averageMatchScore: 0, // Set to 0 since helper_suggestions functionality not yet implemented
        topSkills: topSkillsResult.rows
      };
    } catch (error) {
      console.error('Error getting weekly stats:', error);
      return {
        totalNeeds: 0,
        totalHelpers: 0,
        averageMatchScore: 0,
        topSkills: []
      };
    }
  }
}

export const helperMatchingService = new HelperMatchingService();