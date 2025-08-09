import OpenAI from "openai";
import { WebClient } from "@slack/web-api";
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
- Use channel summaries/memberships only as additional weak evidence of topical fit
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
        model: "gpt-4.1",
      });

      // Optionally DM full prompt to admin for inspection
      try {
        const adminId = process.env.ADMIN_USER_ID;
        const slackToken = process.env.SLACK_BOT_TOKEN;
        if (adminId && slackToken) {
          const slack = new WebClient(slackToken);
          const promptString = `System Prompt\n\n\`\`\`\n${systemPrompt}\n\`\`\`\n\nUser Content JSON\n\n\`\`\`json\n${JSON.stringify(
            userContent,
            null,
            2
          )}\n\`\`\``;
          await slack.chat.postMessage({
            channel: adminId,
            text: `Rerank prompt for review`,
            blocks: [
              {
                type: "header",
                text: {
                  type: "plain_text",
                  text: "🔎 Rerank Prompt (debug)",
                  emoji: true,
                },
              },
              { type: "section", text: { type: "mrkdwn", text: promptString } },
            ],
          });
        }
      } catch (dmErr) {
        console.warn("⚠️ Failed to DM rerank prompt to admin:", dmErr);
      }
      const response = await this.openai.chat.completions.create({
        model: "gpt-4.1",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userContent) },
        ],
        temperature: 0.1,
        max_tokens: 400,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) throw new Error("No response from GPT-4");

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
        model: "gpt-4.1",
      });
      const response = await this.openai.chat.completions.create({
        model: "gpt-4.1",
        messages: [
          {
            role: "system",
            content: `${SKILL_EXTRACTION_CONTEXT}\n\nYou are a technical skill analyzer. Given a request for help, extract 3-15 specific technical skills that would be needed to help this person.\n\nReturn ONLY a JSON array of skill strings. Be specific and technical. Focus on concrete skills, technologies, and competencies rather than soft skills.\n\nExamples:\n- "I need help deploying my React app" → ["React.js", "deployment", "CI/CD", "web hosting"]\n- "My database queries are slow" → ["SQL optimization", "database performance", "query analysis", "indexing"]\n- "Setting up authentication" → ["authentication", "JWT", "OAuth", "security", "user management"]`,
          },
          {
            role: "user",
            content: needText,
          },
        ],
        temperature: 0.2,
        max_tokens: 500,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) throw new Error("No response from GPT-4");

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
      const fallbackModel = "gpt-4.1-mini";
      const fallback = await this.openai.chat.completions.create({
        model: fallbackModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 250,
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
