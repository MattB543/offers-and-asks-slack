import OpenAI from "openai";
import { SKILL_EXTRACTION_CONTEXT } from "./promptContext";

export class EmbeddingService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const start = Date.now();
      console.log("🧠 [EmbeddingService] generateEmbedding: start", {
        textPreview: text.substring(0, 80),
        length: text.length,
        model: "text-embedding-3-small",
      });
      const response = await this.openai.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
      });
      const embedding = response.data[0].embedding;
      console.log("🧠 [EmbeddingService] generateEmbedding: success", {
        vectorLength: embedding.length,
        ms: Date.now() - start,
      });
      return embedding;
    } catch (error) {
      console.error("Error generating embedding:", error);
      throw new Error(`Failed to generate embedding: ${error}`);
    }
  }

  async generateMultipleEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      const start = Date.now();
      console.log("🧠 [EmbeddingService] generateMultipleEmbeddings: start", {
        count: texts.length,
        firstPreview: texts[0]?.substring(0, 60),
        model: "text-embedding-3-small",
      });
      const response = await this.openai.embeddings.create({
        model: "text-embedding-3-small",
        input: texts,
      });
      const vectors = response.data.map((item) => item.embedding);
      console.log("🧠 [EmbeddingService] generateMultipleEmbeddings: success", {
        vectors: vectors.length,
        vectorLength: vectors[0]?.length,
        ms: Date.now() - start,
      });
      return vectors;
    } catch (error) {
      console.error("Error generating multiple embeddings:", error);
      throw new Error(`Failed to generate embeddings: ${error}`);
    }
  }

  async rerankCandidates(
    needText: string,
    candidates: Array<{
      id: string;
      name: string;
      slack_user_id?: string;
      expertise?: string | null;
      projects?: string | null;
      offers?: string | null;
      skills: string[];
      matched_skills?: Array<{ skill: string; score?: number }>;
    }>,
    finalCount: number = 5,
    channelsContext?: Array<{
      channel_id: string;
      channel_name: string | null;
      summary: string | null;
      member_ids: string[];
      member_names: string[];
    }>
  ): Promise<string[]> {
    const systemPrompt = `You are an expert recruiter helping to match a person's request with the best teammates to help.
Re-rank candidates based on:
1) Direct skill relevance to the need
2) Demonstrated expertise/projects/offers relevance
3) Breadth and depth of adjacent skills
4) Relevance of Slack channel participation to the need (use channels context below)

Rules:
- Prefer candidates whose concrete experience clearly addresses the need
- Treat channel summaries/memberships as meaningful evidence of topical fit; when channels clearly align with the need, weigh this alongside skills and experience
- Break ties by higher specificity and stronger evidence in projects/offers
- Output ONLY a JSON object with shape { "ids": ["candidate_user_id", ...] } of length ${finalCount}
- Do not include any text before or after the JSON`;

    const userContent = {
      need: needText,
      candidates: candidates.map((c) => ({
        id: c.id,
        name: c.name,
        slack_user_id: c.slack_user_id,
        expertise: c.expertise || undefined,
        projects: c.projects || undefined,
        offers: c.offers || undefined,
        skills: c.skills,
        matched_skills: c.matched_skills,
      })),
      final_count: finalCount,
      channels_context: (channelsContext || []).map((ch) => ({
        channel_id: ch.channel_id,
        channel_name: ch.channel_name,
        summary: ch.summary,
        member_ids: ch.member_ids,
        member_names: ch.member_names,
      })),
    };

    try {
      const start = Date.now();
      console.log("🧠 [EmbeddingService] rerankCandidates: start", {
        candidates: candidates.length,
        finalCount,
        needPreview: needText.substring(0, 100),
        model: "gpt-5-mini",
      });

      // Log full prompt for inspection instead of DM
      const promptFull = `System Prompt\n\n\`\`\`\n${systemPrompt}\n\`\`\`\n\nUser Content JSON\n\n\`\`\`json\n${JSON.stringify(
        userContent,
        null,
        2
      )}\n\`\`\``;
      console.log(
        "🧪 [EmbeddingService] rerankCandidates prompt (full)",
        promptFull
      );
      // Try primary and fallback models for robustness
      const models = ["gpt-5-mini", "gpt-4.1", "gpt-4o-mini"];
      let content: string | undefined;
      let lastError: any;
      for (const model of models) {
        try {
          const params: any = {
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: JSON.stringify(userContent) },
            ],
            temperature: 1,
          };
          if (model.startsWith("gpt-5-mini")) {
            params.max_completion_tokens = 400;
          } else {
            params.max_tokens = 400;
          }
          const resp = await this.openai.chat.completions.create(params);
          content = resp.choices[0]?.message?.content?.trim();
          if (content) break;
        } catch (e) {
          lastError = e;
          continue;
        }
      }
      if (!content)
        throw new Error(
          `No response from model: ${String(lastError || "unknown")}`
        );

      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        // Some models occasionally wrap JSON in code fences; attempt to strip
        const cleaned = content
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/```\s*$/i, "");
        parsed = JSON.parse(cleaned);
      }

      if (!parsed || !Array.isArray(parsed.ids)) {
        throw new Error("Unexpected response shape");
      }
      const ids = parsed.ids.slice(0, finalCount);
      console.log("🧠 [EmbeddingService] rerankCandidates: success", {
        returned: ids.length,
        ms: Date.now() - start,
        idsPreview: ids.slice(0, 5),
      });
      return ids;
    } catch (error) {
      console.error("Error re-ranking candidates:", error);
      throw new Error(`Failed to re-rank candidates: ${error}`);
    }
  }

  async extractSkills(needText: string): Promise<string[]> {
    try {
      const start = Date.now();
      console.log("🧠 [EmbeddingService] extractSkills: start", {
        needPreview: needText.substring(0, 120),
        model: "gpt-5-mini",
      });
      const skillPrompt = `${SKILL_EXTRACTION_CONTEXT}\n\nYou are a technical skill analyzer. Given a request for help, extract 3-15 specific technical skills that would be needed to help this person.\n\nReturn ONLY a JSON array of skill strings. Be specific and technical. Focus on concrete skills, technologies, and competencies rather than soft skills.\n\nExamples:\n- "I need help deploying my React app" → ["React.js", "deployment", "CI/CD", "web hosting"]\n- "My database queries are slow" → ["SQL optimization", "database performance", "query analysis", "indexing"]\n- "Setting up authentication" → ["authentication", "JWT", "OAuth", "security", "user management"]`;
      const modelsSkills = ["gpt-5-mini", "gpt-4.1", "gpt-4o-mini"];
      let content: string | undefined;
      let lastSkillError: any;
      for (const model of modelsSkills) {
        try {
          const params: any = {
            model,
            messages: [
              { role: "system", content: skillPrompt },
              { role: "user", content: needText },
            ],
            temperature: 1,
          };
          if (model.startsWith("gpt-5-mini")) {
            params.max_completion_tokens = 500;
          } else {
            params.max_tokens = 500;
          }
          const resp = await this.openai.chat.completions.create(params);
          content = resp.choices[0]?.message?.content?.trim();
          if (content) break;
        } catch (e) {
          lastSkillError = e;
          continue;
        }
      }
      if (!content)
        throw new Error(
          `No response from model: ${String(lastSkillError || "unknown")}`
        );

      const skills = JSON.parse(content);
      if (!Array.isArray(skills)) throw new Error("Response is not an array");
      const normalized = skills.filter(
        (skill) => typeof skill === "string" && skill.length > 0
      );
      console.log("🧠 [EmbeddingService] extractSkills: success", {
        count: normalized.length,
        sample: normalized.slice(0, 5),
        ms: Date.now() - start,
      });

      return normalized;
    } catch (error) {
      console.error("Error extracting skills:", error);
      throw new Error(`Failed to extract skills: ${error}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    // A simple, no-cost check is to see if the API key is configured.
    const isConfigured = !!this.openai.apiKey;
    if (!isConfigured) {
      console.error("OpenAI health check failed: API key is missing.");
    }
    return isConfigured;
  }

  /**
   * Generate exactly three concise bullet points explaining why a helper is a good fit for a need.
   */
  async generateFitSummaryForHelper(input: {
    needText: string;
    helper: {
      id: string;
      name: string;
      slack_user_id?: string;
      expertise?: string | null;
      projects?: string | null;
      offers?: string | null;
      skills?: string[];
      asks?: string | null;
      most_interested_in?: string | null;
      confusion?: string | null;
      channels?: Array<{ channel_name: string | null; summary: string | null }>;
      messages?: string[];
    };
  }): Promise<string> {
    const { needText, helper } = input;
    const systemPrompt =
      "You write crisp, evidence-based, highly specific bullets explaining why this teammate is a strong fit for the given request." +
      " Output exactly THREE bullet points as incomplete sentences, each starting with '- '." +
      " Do not include their name, pronouns, or @mentions (the name is shown elsewhere)." +
      " Use only information provided in the request and person fields; do not invent details." +
      " Prioritize concrete evidence: directly relevant skills/experience, notable projects or offers, and relevant Slack channels (format as #channel_name) or recent message themes." +
      " Prefer short 'why-they-fit' phrasing over raw skill lists. No fluff. Keep each bullet ~8–16 words. Output only the three bullets (no intro/outro).";

    const userPayload = {
      request: needText,
      person: {
        id: helper.id,
        name: helper.name,
        slack_user_id: helper.slack_user_id,
        expertise: helper.expertise || undefined,
        projects: helper.projects || undefined,
        offers: helper.offers || undefined,
        asks: helper.asks || undefined,
        most_interested_in: helper.most_interested_in || undefined,
        confusion: helper.confusion || undefined,
        skills: helper.skills || [],
        channels: (helper.channels || []).map((c) => ({
          name: c.channel_name,
          summary: c.summary,
        })),
        sample_messages: (helper.messages || []).slice(-50),
      },
    };

    const models = ["gpt-5-mini", "gpt-4o-mini"];
    let content: string | undefined;
    let lastError: any;
    for (const model of models) {
      try {
        const params: any = {
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: JSON.stringify(userPayload) },
          ],
          temperature: 0.7,
        };
        if (model.startsWith("gpt-5-mini")) {
          params.max_completion_tokens = 180;
        } else {
          params.max_tokens = 180;
        }
        const resp = await this.openai.chat.completions.create(params);
        content = resp.choices[0]?.message?.content?.trim();
        if (content) break;
      } catch (e) {
        lastError = e;
        continue;
      }
    }
    if (!content) {
      throw new Error(
        `No response from model for fit summary: ${String(
          lastError || "unknown"
        )}`
      );
    }

    // Normalize to exactly three hyphen bullets, incomplete sentences if possible
    const normalizeToBullets = (raw: string): string => {
      const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      // Prefer existing bullet-like lines first
      let bullets = lines
        .map((l) => {
          // Strip common bullet markers and normalize to '- '
          const m = l.match(/^(?:[-*•—]\s*)(.*)$/);
          let text = (m ? m[1] : l).trim();
          // Remove accidental inclusion of name or slack mention
          if (helper.name) {
            const nameRe = new RegExp(
              helper.name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"),
              "ig"
            );
            text = text.replace(nameRe, "").trim();
          }
          if (helper.slack_user_id) {
            const mention = `<@${helper.slack_user_id}>`;
            const mentionRe = new RegExp(
              mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              "g"
            );
            text = text.replace(mentionRe, "").trim();
          }
          // Light length cap (~18 words); keep concise
          const words = text.split(/\s+/).filter(Boolean);
          if (words.length > 18) text = words.slice(0, 18).join(" ");
          return text.length > 0 ? `- ${text}` : "";
        })
        .filter((l) => l);

      // If we didn't get at least 3 bullet-ish lines, fall back to sentence split
      if (bullets.length < 3) {
        const sentences = raw
          .replace(/\s+/g, " ")
          .split(/(?<=[.!?])\s+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .slice(0, 3);
        bullets = sentences.map((s) => {
          let t = s;
          if (helper.name) {
            const nameRe = new RegExp(
              helper.name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"),
              "ig"
            );
            t = t.replace(nameRe, "").trim();
          }
          if (helper.slack_user_id) {
            const mention = `<@${helper.slack_user_id}>`;
            const mentionRe = new RegExp(
              mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              "g"
            );
            t = t.replace(mentionRe, "").trim();
          }
          const words = t.split(/\s+/).filter(Boolean);
          if (words.length > 18) t = words.slice(0, 18).join(" ");
          return `- ${t}`;
        });
      }

      // Enforce exactly three bullets
      if (bullets.length > 3) bullets = bullets.slice(0, 3);
      while (bullets.length < 3) bullets.push("- ");
      return bullets.join("\n");
    };

    const result = normalizeToBullets(content).trim();
    return result || content;
  }
}

export const embeddingService = new EmbeddingService();

export class ChannelSummarizerService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async summarizeChannel(
    messages: string[],
    model: string = "gpt-5-mini"
  ): Promise<{ summary: string; model: string }> {
    const systemPrompt =
      "You are summarizing the purpose and typical content of a Slack channel. Produce 1 to 5 sentences, concise and general, avoiding proper names unless they indicate topics.";

    // Preprocess: trim messages and cap token budget by slicing
    const joined = messages
      .map((m) => (m || "").replace(/[\s\u200B]+/g, " ").trim())
      .filter((m) => m.length > 0)
      .slice(-100) // cap to the most recent 100 messages
      .join("\n- ");

    const userPrompt = `Here are representative recent messages from a Slack channel. Write a concise summary in 1 to 5 sentences.\n\nMessages:\n- ${joined}`;

    const response = await this.openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: 250,
    });
    let content = response.choices[0]?.message?.content?.trim() || "";
    if (!content || content.length < 10) {
      // Fallback to a more permissive/completions-friendly model if result is empty
      const fallbackModel = "gpt-5-mini";
      const fallback = await this.openai.chat.completions.create({
        model: fallbackModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 1,
        max_completion_tokens: 250,
      });
      content = fallback.choices[0]?.message?.content?.trim() || "";
      const summary = content
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .join(" ");
      return { summary, model: content ? fallbackModel : model };
    }

    const summary = content
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .join(" ");
    return { summary, model };
  }
}

export const channelSummarizerService = new ChannelSummarizerService();
