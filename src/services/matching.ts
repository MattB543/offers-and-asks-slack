import { db } from "../lib/database";
import { embeddingService } from "../lib/openai";

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
  async findHelpers(
    needText: string,
    requesterId?: string,
    limit: number = 5
  ): Promise<Helper[]> {
    try {
      console.log("🎯 [HelperMatchingService] findHelpers: start", {
        needPreview: needText.substring(0, 120),
        requesterId,
        limit,
      });

      // Extract specific skills needed using GPT-4
      const extractedSkills = await embeddingService.extractSkills(needText);
      console.log("🎯 [HelperMatchingService] extracted skills", {
        count: extractedSkills.length,
        sample: extractedSkills.slice(0, 10),
      });

      // Generate embeddings for each extracted skill
      const skillEmbeddings = await embeddingService.generateMultipleEmbeddings(
        extractedSkills
      );
      console.log("🎯 [HelperMatchingService] skill embeddings generated", {
        embeddings: skillEmbeddings.length,
        vectorLength: skillEmbeddings[0]?.length,
      });

      // Store the need with original text embedding if requesterId is provided
      const needEmbedding = await embeddingService.generateEmbedding(needText);
      console.log("🎯 [HelperMatchingService] need embedding generated", {
        vectorLength: needEmbedding.length,
      });
      if (requesterId) {
        const weekStart = this.getWeekStart(new Date());
        console.log("🗄️  [HelperMatchingService] creating weekly need", {
          weekStart,
        });
        await db.createWeeklyNeed(
          requesterId,
          needText,
          needEmbedding,
          weekStart
        );
        console.log("🗄️  [HelperMatchingService] weekly need stored", {
          requesterId,
          weekStart,
          textPreview: needText.substring(0, 80),
        });
      }

      // Find similar helpers for each skill and combine results
      const allSimilarHelpers = [] as any[];
      console.log(
        "🔎 [HelperMatchingService] finding similar helpers per skill...",
        { skillsCount: extractedSkills.length }
      );
      for (let i = 0; i < skillEmbeddings.length; i++) {
        console.log("🔎 [HelperMatchingService] querying for skill", {
          index: i,
          skill: extractedSkills[i],
        });
        const skillHelpers = await db.findSimilarHelpers(
          skillEmbeddings[i],
          10
        );
        console.log("🔎 [HelperMatchingService] results", {
          index: i,
          count: skillHelpers.length,
          sampleHelperNames: skillHelpers
            .slice(0, 3)
            .map((h: any) => h.display_name || h.user_id),
        });
        // Add skill context to each result
        const skillHelpersWithContext = skillHelpers.map((helper) => ({
          ...helper,
          matchedSkillQuery: extractedSkills[i],
        }));
        allSimilarHelpers.push(...skillHelpersWithContext);
      }

      // Group by person and aggregate their top skills
      console.log("🧮 [HelperMatchingService] aggregating helper results", {
        rawCount: allSimilarHelpers.length,
      });
      const helperMap = new Map<string, Helper>();

      for (const row of allSimilarHelpers) {
        // Skip the requester from results (match by either internal user_id or Slack user id)
        if (
          requesterId &&
          (row.user_id === requesterId || row.slack_user_id === requesterId)
        ) {
          console.log(
            "↩️  [HelperMatchingService] skipping requester in results",
            {
              requesterId,
            }
          );
          continue;
        }

        let helper = helperMap.get(row.user_id);
        if (!helper) {
          helper = {
            id: row.user_id,
            slack_user_id: row.slack_user_id,
            name: row.display_name || "Unknown",
            skills: [],
            score: row.score,
            expertise: row.expertise,
            projects: row.projects,
            offers: row.offers,
          };
          helperMap.set(row.user_id, helper);
        }

        // Add skill with score if not already present and we have room
        const existingSkill = helper.skills.find((s) => s.skill === row.skill);
        if (!existingSkill && helper.skills.length < 3) {
          helper.skills.push({
            skill: row.skill,
            score: row.score,
          });
        }

        // Update overall score to be the max score across all their skills
        if (row.score > (helper.score || 0)) {
          helper.score = row.score;
        }
      }

      // Convert to array, sort skills within each helper, exclude requester
      const aggregatedHelpers = Array.from(helperMap.values())
        .map((helper) => ({
          ...helper,
          skills: helper.skills.sort((a, b) => b.score - a.score),
        }))
        .filter((helper) => helper.skills.length > 0)
        .filter(
          (helper) =>
            !requesterId ||
            (helper.slack_user_id !== requesterId && helper.id !== requesterId)
        )
        .sort((a, b) => (b.score || 0) - (a.score || 0));
      console.log("🧮 [HelperMatchingService] aggregated helpers", {
        count: aggregatedHelpers.length,
        topNames: aggregatedHelpers.slice(0, 5).map((h) => h.name),
      });

      // Take top 10 for AI re-ranking
      const topForRerank = aggregatedHelpers.slice(0, 10);
      console.log("📊 [HelperMatchingService] top candidates for re-rank", {
        count: topForRerank.length,
        topNames: topForRerank.slice(0, 5).map((h) => h.name),
      });

      // If fewer than or equal to limit, just return
      if (topForRerank.length <= limit) {
        console.log("✅ [HelperMatchingService] returning without re-rank", {
          returned: topForRerank.length,
        });
        return topForRerank;
      }

      // Ask AI to re-rank these candidates considering their full context
      try {
        // Fetch full skill lists for each candidate from DB
        const fullSkillsList = await Promise.all(
          topForRerank.map(async (h) => {
            const rows = await db.getPersonSkills(h.slack_user_id || h.id);
            return {
              id: h.id,
              skills: rows.map((r: any) => r.skill) as string[],
            };
          })
        );
        console.log(
          "📚 [HelperMatchingService] fetched full skills for candidates",
          { count: fullSkillsList.length }
        );
        const idToAllSkills = new Map(
          fullSkillsList.map((x) => [x.id, x.skills] as const)
        );

        const idsInOrder = await embeddingService.rerankCandidates(
          needText,
          topForRerank.map((h) => ({
            id: h.id,
            name: h.name,
            slack_user_id: h.slack_user_id,
            expertise: h.expertise,
            projects: h.projects,
            offers: h.offers,
            skills: idToAllSkills.get(h.id) || h.skills.map((s) => s.skill),
            matched_skills: h.skills.map((s) => ({
              skill: s.skill,
              score: s.score,
            })),
          })),
          limit
        );
        console.log("🏁 [HelperMatchingService] re-rank complete", {
          returned: idsInOrder.length,
          returnedIdsPreview: idsInOrder.slice(0, 5),
        });

        // Build a map for quick lookup and return in AI order
        const byId = new Map(topForRerank.map((h) => [h.id, h] as const));
        const reRanked = idsInOrder
          .map((id) => byId.get(id))
          .filter((x): x is Helper => !!x);

        // Fallback: if AI returned fewer than needed, top off with remaining from similarity order
        const remaining = topForRerank.filter(
          (h) => !idsInOrder.includes(h.id)
        );
        const finalList = [...reRanked, ...remaining].slice(0, limit);
        console.log("✅ [HelperMatchingService] final list prepared", {
          returned: finalList.length,
          names: finalList.slice(0, 5).map((h) => h.name),
        });
        return finalList;
      } catch (rerankError) {
        console.warn(
          "⚠️  [HelperMatchingService] re-ranking failed, using similarity order:",
          rerankError
        );
        return aggregatedHelpers.slice(0, limit);
      }
    } catch (error) {
      console.error("❌ [HelperMatchingService] Error finding helpers:", error);
      throw new Error(`Failed to find helpers: ${error}`);
    }
  }

  async findHelpersForMultipleNeeds(
    needs: Array<{ text: string; requesterId: string }>
  ): Promise<Map<string, Helper[]>> {
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
    return d.toISOString().split("T")[0]!; // YYYY-MM-DD format
  }

  async getWeeklyStats(): Promise<{
    totalNeeds: number;
    totalHelpers: number;
    averageMatchScore: number;
    topSkills: Array<{ skill: string; count: number }>;
  }> {
    try {
      const weekStart = this.getWeekStart(new Date());

      // Get total needs for this week
      const needsResult = await db.query(
        "SELECT COUNT(*) as count FROM weekly_needs WHERE week_start = $1",
        [weekStart]
      );

      // Get total active helpers
      const helpersResult = await db.query(
        "SELECT COUNT(DISTINCT ps.user_id) as count FROM person_skills ps JOIN people p ON ps.user_id = p.user_id WHERE p.enabled = TRUE"
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
        JOIN people p ON ps.user_id = p.user_id
        WHERE p.enabled = TRUE
        GROUP BY s.skill
        ORDER BY count DESC
        LIMIT 10
      `);

      return {
        totalNeeds: parseInt(needsResult.rows[0].count),
        totalHelpers: parseInt(helpersResult.rows[0].count),
        averageMatchScore: 0, // Set to 0 since helper_suggestions functionality not yet implemented
        topSkills: topSkillsResult.rows,
      };
    } catch (error) {
      console.error("Error getting weekly stats:", error);
      return {
        totalNeeds: 0,
        totalHelpers: 0,
        averageMatchScore: 0,
        topSkills: [],
      };
    }
  }
}

export const helperMatchingService = new HelperMatchingService();
