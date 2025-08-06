import { db } from '../lib/database';
import { embeddingService } from '../lib/openai';

export interface HelperSkill {
  skill: string;
  score: number;
}

export interface Helper {
  id: string;
  slack_user_id?: string;
  name: string;
  skills: HelperSkill[];
  score?: number;
  expertise?: string;
  projects?: string;
  offers?: string;
}

export class HelperMatchingService {
  async findHelpers(needText: string, requesterId?: string, limit: number = 5): Promise<Helper[]> {
    try {
      // Extract specific skills needed using GPT-4
      const extractedSkills = await embeddingService.extractSkills(needText);
      console.log('Extracted skills:', extractedSkills);
      
      // Generate embeddings for each extracted skill
      const skillEmbeddings = await embeddingService.generateMultipleEmbeddings(extractedSkills);
      
      // Store the need with original text embedding if requesterId is provided
      const needEmbedding = await embeddingService.generateEmbedding(needText);
      if (requesterId) {
        const weekStart = this.getWeekStart(new Date());
        await db.createWeeklyNeed(requesterId, needText, needEmbedding, weekStart);
      }
      
      // Find similar helpers for each skill and combine results
      const allSimilarHelpers = [];
      for (let i = 0; i < skillEmbeddings.length; i++) {
        const skillHelpers = await db.findSimilarHelpers(skillEmbeddings[i], 10);
        // Add skill context to each result
        const skillHelpersWithContext = skillHelpers.map(helper => ({
          ...helper,
          matchedSkillQuery: extractedSkills[i]
        }));
        allSimilarHelpers.push(...skillHelpersWithContext);
      }
      
      // Group by person and aggregate their top skills
      const helperMap = new Map<string, Helper>();
      
      for (const row of allSimilarHelpers) {
        // Skip the requester from results
        if (requesterId && row.user_id === requesterId) {
          continue;
        }
        
        let helper = helperMap.get(row.user_id);
        if (!helper) {
          helper = {
            id: row.user_id,
            slack_user_id: row.slack_user_id,
            name: row.display_name || 'Unknown',
            skills: [],
            score: row.score,
            expertise: row.expertise,
            projects: row.projects,
            offers: row.offers
          };
          helperMap.set(row.user_id, helper);
        }
        
        // Add skill with score if not already present and we have room
        const existingSkill = helper.skills.find(s => s.skill === row.skill);
        if (!existingSkill && helper.skills.length < 3) {
          helper.skills.push({
            skill: row.skill,
            score: row.score
          });
        }
        
        // Update overall score to be the max score across all their skills
        if (row.score > (helper.score || 0)) {
          helper.score = row.score;
        }
      }
      
      // Convert to array, sort skills within each helper, then sort helpers by score
      const helpers = Array.from(helperMap.values())
        .map(helper => ({
          ...helper,
          // Sort skills by relevance score (highest first)
          skills: helper.skills.sort((a, b) => b.score - a.score)
        }))
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