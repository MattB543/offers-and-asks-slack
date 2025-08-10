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
    limit: number = 5,
    capturePrompt?: (type: string, content: string) => void
  ): Promise<Helper[]> {
    let needId: number | null = null;
    try {
      const overallStart = Date.now();
      console.log("🎯 [HelperMatchingService] findHelpers: start", {
        needPreview: needText.substring(0, 120),
        requesterId,
        limit,
      });

      // Extract specific skills needed using GPT-4
      const skillExtractStart = Date.now();
      const extractedSkills = await embeddingService.extractSkills(
        needText,
        capturePrompt
      );
      console.log("🎯 [HelperMatchingService] extracted skills", {
        count: extractedSkills.length,
        sample: extractedSkills.slice(0, 10),
      });

      // Generate embeddings for each extracted skill
      const multiEmbedStart = Date.now();
      const skillEmbeddings = await embeddingService.generateMultipleEmbeddings(
        extractedSkills
      );
      console.log("🎯 [HelperMatchingService] skill embeddings generated", {
        embeddings: skillEmbeddings.length,
        vectorLength: skillEmbeddings[0]?.length,
      });

      // Store the need with original text embedding if requesterId is provided
      const needEmbedStart = Date.now();
      const needEmbedding = await embeddingService.generateEmbedding(needText);
      console.log("🎯 [HelperMatchingService] need embedding generated", {
        vectorLength: needEmbedding.length,
      });
      if (requesterId) {
        const weekStart = this.getWeekStart(new Date());
        console.log("🗄️  [HelperMatchingService] creating weekly need", {
          weekStart,
        });
        needId = await db.createWeeklyNeed(
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

        // Persist initial processing data
        try {
          await db.updateWeeklyNeedProcessing(needId, {
            skillsExtracted: extractedSkills,
            processingMetadataJson: {
              timings_ms: {
                extract_skills: Date.now() - skillExtractStart,
                embed_skills: Date.now() - multiEmbedStart,
                embed_need: Date.now() - needEmbedStart,
              },
              need_text_length: needText.length,
              skill_count: extractedSkills.length,
              need_embedding_length: needEmbedding.length,
            },
          });
        } catch (persistErr) {
          console.warn(
            "⚠️ Failed to persist initial processing data:",
            persistErr
          );
        }
      }

      // Find similar helpers for each skill and combine results
      const allSimilarHelpers = [] as any[];
      const bySkillCandidates: Array<{
        skill: string;
        candidates: Array<{
          user_id: string;
          slack_user_id?: string;
          name?: string;
          score: number;
        }>;
      }> = [];
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

        bySkillCandidates.push({
          skill: extractedSkills[i],
          candidates: skillHelpers.map((h: any) => ({
            user_id: h.user_id,
            slack_user_id: h.slack_user_id,
            name: h.display_name,
            score: h.score,
          })),
        });
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

      // Persist similarity candidates if we created a weekly need
      try {
        if (typeof needId === "number" && needId) {
          await db.updateWeeklyNeedProcessing(needId, {
            similarityCandidatesJson: {
              by_skill: bySkillCandidates,
              aggregated_top: aggregatedHelpers.slice(0, 20).map((h) => ({
                user_id: h.id,
                slack_user_id: h.slack_user_id,
                name: h.name,
                top_skills: h.skills.map((s) => ({
                  skill: s.skill,
                  score: s.score,
                })),
                score: h.score,
              })),
            },
          });
        }
      } catch (persistErr) {
        console.warn("⚠️ Failed to persist similarity candidates:", persistErr);
      }

      // Take top 10 for AI re-ranking
      const topForRerank = aggregatedHelpers.slice(0, 10);
      console.log("📊 [HelperMatchingService] top candidates for re-rank", {
        count: topForRerank.length,
        topNames: topForRerank.slice(0, 5).map((h) => h.name),
      });

      // If fewer than or equal to limit, just return
      if (topForRerank.length <= limit) {
        // Persist final without rerank path
        try {
          if (typeof needId === "number" && needId) {
            await db.updateWeeklyNeedProcessing(needId, {
              rerankedCandidatesJson: {
                final_list: topForRerank.map((h) => ({
                  user_id: h.id,
                  slack_user_id: h.slack_user_id,
                  name: h.name,
                  skills: h.skills,
                  score: h.score,
                })),
              },
              processingMetadataJson: {
                finalized_without_rerank: true,
                total_ms: Date.now() - overallStart,
              },
            });
          }
        } catch (persistErr) {
          console.warn(
            "⚠️ Failed to persist final results (no rerank):",
            persistErr
          );
        }
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

        // Build channels context: any channels that include at least one of the 10 candidates
        const candidateSlackIds = topForRerank
          .map((h) => h.slack_user_id)
          .filter((id): id is string => !!id);

        let channelsContext: Array<{
          channel_id: string;
          channel_name: string | null;
          summary: string | null;
          member_ids: string[];
          member_names: string[];
        }> = [];
        try {
          channelsContext = await db.getChannelsByMemberSlackIds(
            candidateSlackIds
          );
          // Filter channels and members to only those relevant to the 10 candidates, and drop noisy channels
          const candidateIdSet = new Set(candidateSlackIds);
          const slackIdToName = new Map(
            topForRerank
              .map((h) => [h.slack_user_id, h.name] as const)
              .filter(([id]) => !!id)
          );
          channelsContext = channelsContext
            .filter((ch) => {
              const title = (ch.channel_name || "").toLowerCase();
              if (
                title.includes("lab-notes") ||
                title.includes("surface-area")
              ) {
                return false;
              }
              return true;
            })
            .map((ch) => {
              const filteredMemberIds = (ch.member_ids || []).filter((id) =>
                candidateIdSet.has(id)
              );
              const filteredMemberNames = filteredMemberIds.map(
                (id) => slackIdToName.get(id) || id
              );
              return {
                ...ch,
                member_ids: filteredMemberIds,
                member_names: filteredMemberNames,
              };
            })
            .filter((ch) => ch.member_ids.length > 0);
        } catch (e) {
          console.warn(
            "⚠️ Failed to load channels context for rerank; proceeding without it",
            e
          );
        }

        // Fetch recent authored messages for each candidate to include as auxiliary context
        const idToMessages = new Map<string, string[]>();
        try {
          const messageFetchResults = await Promise.all(
            topForRerank.map(async (h) => {
              const key = h.id;
              const slackId = h.slack_user_id || h.id;
              try {
                const msgs = await db.getUserMessages(slackId, 100);
                return { id: key, messages: msgs };
              } catch (err) {
                console.warn("⚠️ Failed to fetch messages for candidate", {
                  id: key,
                  slackId,
                  err,
                });
                return { id: key, messages: [] as string[] };
              }
            })
          );
          for (const item of messageFetchResults) {
            idToMessages.set(item.id, item.messages);
          }
          console.log(
            "📚 [HelperMatchingService] fetched recent messages for candidates",
            { count: idToMessages.size }
          );
        } catch (e) {
          console.warn(
            "⚠️ Failed to load candidate messages for rerank; proceeding without them",
            e
          );
        }

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
            messages: idToMessages.get(h.id) || [],
            matched_skills: h.skills.map((s) => ({
              skill: s.skill,
              score: s.score,
            })),
          })),
          limit,
          channelsContext,
          capturePrompt
        );
        console.log("🏁 [HelperMatchingService] re-rank complete", {
          returned: idsInOrder.length,
          returnedIdsPreview: idsInOrder.slice(0, 5),
        });

        // Build maps for quick lookup using both internal ids and Slack ids
        const byInternalId = new Map(
          topForRerank.map((h) => [h.id, h] as const)
        );
        const bySlackId = new Map(
          topForRerank.map((h) => [h.slack_user_id || h.id, h] as const)
        );

        // Return in AI order, resolving ids that are Slack user ids (preferred) or internal ids
        const reRanked = idsInOrder
          .map((id) => bySlackId.get(id) || byInternalId.get(id))
          .filter((x): x is Helper => !!x);

        // Fallback: if AI returned fewer than needed, top off with remaining from similarity order
        const reRankedIdsSet = new Set(reRanked.map((h) => h.id));
        const remaining = topForRerank.filter((h) => !reRankedIdsSet.has(h.id));
        const finalList = [...reRanked, ...remaining].slice(0, limit);
        console.log("✅ [HelperMatchingService] final list prepared", {
          returned: finalList.length,
          names: finalList.slice(0, 5).map((h) => h.name),
        });

        // Persist rerank outputs
        try {
          if (typeof needId === "number" && needId) {
            await db.updateWeeklyNeedProcessing(needId, {
              rerankedIds: idsInOrder,
              rerankedCandidatesJson: {
                final_list: finalList.map((h) => ({
                  user_id: h.id,
                  slack_user_id: h.slack_user_id,
                  name: h.name,
                  skills: h.skills,
                  score: h.score,
                })),
              },
              processingMetadataJson: {
                finalized_without_rerank: false,
                total_ms: Date.now() - overallStart,
              },
            });
          }
        } catch (persistErr) {
          console.warn("⚠️ Failed to persist rerank outputs:", persistErr);
        }
        return finalList;
      } catch (rerankError) {
        console.warn(
          "⚠️  [HelperMatchingService] re-ranking failed, using similarity order:",
          rerankError
        );
        const fallback = aggregatedHelpers.slice(0, limit);
        // Persist fallback
        try {
          if (typeof needId === "number" && needId) {
            await db.updateWeeklyNeedProcessing(needId, {
              rerankedIds: null,
              rerankedCandidatesJson: {
                final_list: fallback.map((h) => ({
                  user_id: h.id,
                  slack_user_id: h.slack_user_id,
                  name: h.name,
                  skills: h.skills,
                  score: h.score,
                })),
              },
              error: String(rerankError),
              processingMetadataJson: {
                rerank_failed: true,
                total_ms: Date.now() - overallStart,
              },
            });
          }
        } catch (persistErr) {
          console.warn("⚠️ Failed to persist fallback outputs:", persistErr);
        }
        return fallback;
      }
    } catch (error) {
      console.error("❌ [HelperMatchingService] Error finding helpers:", error);
      // Best-effort: attempt to persist error if we created a weekly need in scope
      try {
        if (typeof needId === "number" && needId) {
          await db.updateWeeklyNeedProcessing(needId, {
            error: String(error),
          });
        }
      } catch {}
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
