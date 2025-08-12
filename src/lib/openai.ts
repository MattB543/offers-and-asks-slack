import OpenAI from "openai";
import { SKILL_EXTRACTION_CONTEXT } from "./promptContext";

// Channels to exclude from prompts (case-insensitive, ignores leading '#')
const BLOCKED_CHANNEL_NAMES = new Set([
  "announcements",
  "demos",
  "distribution",
  "fellowship-water-cooler",
  "general",
]);

const isBlockedChannelName = (name: string | null | undefined): boolean => {
  const normalized = (name || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^#/, "");
  if (BLOCKED_CHANNEL_NAMES.has(normalized)) return true;
  if (normalized.includes("lab-notes")) return true;
  if (normalized.includes("surface-area")) return true;
  return false;
};

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
      messages?: string[];
      matched_skills?: Array<{ skill: string; score?: number }>;
    }>,
    finalCount: number = 5,
    channelsContext?: Array<{
      channel_id: string;
      channel_name: string | null;
      summary: string | null;
      member_ids: string[];
      member_names: string[];
    }>,
    capturePrompt?: (type: string, content: string) => void
  ): Promise<string[]> {
    const systemPrompt = `You are an expert recruiter helping to match a person's request with the best teammates to help.
Re-order candidates so the most relevant candidates are first.

Re-rank candidates based on:
1) Direct skill relevance to the need
2) Demonstrated expertise/projects/offers relevance
3) Breadth and depth of adjacent skills
4) Relevance of Slack channel participation to the need (use channels context below)

Rules:
- The strongest signal is 'expertise', 'offers', and 'projects', but consider all data supplied
- Prefer candidates whose concrete experience most clearly addresses the need
- Treat Slack messages and channels as auxiliary data, not primary evidence
- Break ties by higher specificity and stronger evidence
- Output ONLY a JSON object with shape { "ids": ["top_candidate_slack_user_id", ...] } of length ${finalCount}
- Do not include any text before or after the JSON`;

    const toTwoSignificantDigits = (value?: number) =>
      typeof value === "number" && Number.isFinite(value)
        ? Number(value.toPrecision(2))
        : undefined;

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
        sample_messages: (c.messages || []).slice(-100),
        matched_skills: c.matched_skills
          ? c.matched_skills.map((ms) => ({
              skill: ms.skill,
              score: toTwoSignificantDigits(ms.score),
            }))
          : undefined,
      })),
      final_count: finalCount,
      channels_context: (channelsContext || [])
        .filter((ch) => !isBlockedChannelName(ch.channel_name))
        .map((ch) => ({
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
      try {
        capturePrompt?.("rerank", `RERANK PROMPT\n\n${promptFull}`);
      } catch {}
      // Use Responses API with gpt-5-mini
      const resp = await this.openai.responses.create({
        model: "gpt-5-mini",
        input: `System Prompt\n\n${systemPrompt}\n\nUser Content JSON\n\n${JSON.stringify(
          userContent
        )}`,
        temperature: 1,
        max_output_tokens: 10000,
      });
      const content = (resp as any).output_text?.trim() as string | undefined;
      try {
        capturePrompt?.(
          "rerank_raw",
          `RERANK MODEL RAW OUTPUT (model=gpt-5-mini)\n\n${content || ""}`
        );
      } catch {}
      if (!content)
        throw new Error(
          "No response text returned by gpt-5-mini (empty output)"
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

  async extractSkills(
    needText: string,
    capturePrompt?: (type: string, content: string) => void
  ): Promise<string[]> {
    try {
      const start = Date.now();
      console.log("🧠 [EmbeddingService] extractSkills: start", {
        needPreview: needText.substring(0, 120),
        model: "gpt-5-mini",
      });
      const skillPrompt = `${SKILL_EXTRACTION_CONTEXT}\n\nDeveloper: Role and Objective\n- Act as a technical skill analyzer. When given a user request, identify and extract 3 to 15 specific technical skills necessary to address the request.\n\nChecklist (do internally; do not output)\n- Read and understand the user's request.\n- Identify concrete, technical, domain-specific competencies that would be required.\n- Exclude all soft skills and general traits.\n- Deduplicate similar skills with canonical terminology.\n- Order skills by relevance to the request (most relevant first).\n- Validate that output is a JSON array of strings, 3–15 items, nothing else.\n\nInstructions\n- Extract highly specific and technical skills, focusing on concrete technologies, methodologies, or competencies relevant to the user's scenario.\n- Exclude all soft skills; only include technical and domain-specific skills.\n- Prefer canonical names for overlapping/duplicate skills.\n- If fewer than 3 skills are confidently identified, return only those skills (as few as 1–2).\n\nContext\n- The user input is provided as \`\${user_request_text}\`.\n\nExample (format only)\n["AI Safety Techniques", "Regulatory Analysis", "Metric Design & KPIs"]\n\nFull example skills list (for guidance only; still exclude soft skills when extracting):\nInterpretability & Explainability, AI Safety Techniques, Computer Vision, Metric Design & KPIs, Survey Design & Analysis, Quantitative Research Methods, Impact Assessment, Evaluation Framework Design, Systems Thinking, Policy Writing, AI Policy Expertise, Regulatory Analysis, Government Relations, Legislative Process, International Relations, Stakeholder Engagement, Standards Development, Nonprofit Management, Board Governance, Startup Founding, Partnership Development, Cross-cultural Communication, Public Speaking, Technical Writing, Workshop Facilitation, Teaching & Training, Web Scraping & Data Collection, Rapid Prototyping / \"Vibe Coding\,  Backend Development (Node, Python, etc.), AI App Prototyping, Model Evaluation & Benchmarking, Statistical Analysis, Data Pipeline Development, Technical AI Safety Research, Business Development, Product Strategy, MVP Design & Scoping, Feature Prioritization, Customer Development, Product Launches, User Research & Interviews, Roadmapping & Strategic Planning, Priority Setting, Market Analysis, Competitive Intelligence, B2B Marketing, Cloud Infrastructure (AWS, GCP, Azure), Collective Intelligence, Deliberative Democracy, Decision Theory, Forecasting & Prediction Markets, Scenario Planning, Product Management, AI Agent Development, MLOps & Model Deployment, Data Science, API Design & Integration, System Architecture, Full-Stack Development, Database Design (SQL, NoSQL, Vector DBs), Prompt Engineering, Vector Embeddings & Similarity Search, RAG Systems (Retrieval-Augmented Generation), Capability Evaluations, AI Control Methods, Product-Market Fit, Mentoring & Coaching, Mediation & Negotiation, Philosophy & Ethics, Economics & Game Theory, Mechanism Design, Pricing Strategy, Data Science & Analytics, Data Visualization, Predictive Modeling, Research Design, Literature Reviews, Coordination Problems, Fundraising (VC, Grants), Scaling Organizations, Operations Management, Theory of Change Development, Community Building, Intros to AI Safety people, LLM Fine-tuning & Training, Agile/Scrum Management, Social Choice Theory, Engineering leadership, Red Teaming, Contract Negotiation, Legal Compliance, Frontend Development (React, Vue, etc.), Board Management, Conflict Resolution, Community Management, Growth Metrics & Analytics, Event Organization, Usability Testing, User Experience (UX) Design, Concept Mapping, Think Tank Experience, Strategic Planning, Editing,"User Interface (UI) Design, Data Privacy (GDPR, etc.), Network Science, Defense & National Security, B2G Marketing (Government), NLP & Text Processing, Ontology Development, 501(c)(3) Formation, Donor Relations, Project Management, Generalist things/things where you’re not sure who else to ask, perhaps?, Content Marketing, Copywriting,"A/B Testing & Experimentation, Networking,"Causal Inference, Behavioral Science, Science Communication, DevOps & CI/CD, Viral Growth Mechanics, Landing Page Optimization, General startup / tech founder knowledge, Cognitive Biases & Heuristics, Mediocre Software Engineering, AI Alignment Theory, Meta-Research,Programming,"Subjective probability estimates, Impact estimation, Risk Assessment, Risk Modeling, Algorithm and Data Structure Design, Performance Optimization, Distributed Software Engineering, Multiagent Cooperation, Business Model Design, Web App Development, Game Design, Incentive Design, Game Development & Industry, Policy Analysis, Public Comment Analysis, Sustainable Consumption, Corporate Sustainability\n\nOutput Format\n- Always return only a JSON array of 3–15 unique, specific technical skill strings relevant to the request.\n- Do not include objects, numbers, or non-string values in the array.\n- If the user input is empty or does not describe a scenario that requires skills, return: []\n- Order all skills by relevance to the user request, most relevant first.\n- Return only the JSON array, with no additional text or explanation.\n\nStop Conditions\n- Output stops after a single valid JSON array is produced per user request.\n- Escalate or return [] only if no technical skills can be confidently extracted.\n\nVerbosity\n- Output is strictly limited to the JSON array and is otherwise silent.\n\nPlanning and Verification (do internally; do not output)\n- Analyze the request, identify relevant technical skills (3–15), deduplicate, and verify the array strictly conforms to all specifications.`;
      const resp = await this.openai.responses.create({
        model: "gpt-5-mini",
        input: `System Prompt\n\n${skillPrompt}\n\nUser Input\n\n${needText}`,
        temperature: 1,
        max_output_tokens: 10000,
      });
      const content = (resp as any).output_text?.trim() as string | undefined;
      if (!content)
        throw new Error(
          "No response text returned by gpt-5-mini (empty output)"
        );

      try {
        capturePrompt?.(
          "skills",
          `SKILL EXTRACTION\n\nSystem Prompt\n\n${skillPrompt}\n\nUser Input\n\n${needText}\n\nModel Raw Output\n\n${content}`
        );
      } catch {}
      // Be robust to models that wrap JSON in code fences
      let parsedSkills: any;
      try {
        parsedSkills = JSON.parse(content);
      } catch {
        const cleaned = content
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/```\s*$/i, "");
        parsedSkills = JSON.parse(cleaned);
      }
      const skills = parsedSkills;
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

  async extractPersonSkills(input: {
    person: {
      name?: string | null;
      expertise?: string | null;
      projects?: string | null;
      offers?: string | null;
      asks?: string | null;
      most_interested_in?: string | null;
      confusion?: string | null;
    };
    messages?: string[];
    exampleSkills?: string[]; // optional guidance for specificity level
    capturePrompt?: (type: string, content: string) => void;
  }): Promise<string[]> {
    const { person, messages = [], exampleSkills = [], capturePrompt } = input;
    const systemPrompt = `${SKILL_EXTRACTION_CONTEXT}\n\nYou analyze a person's profile and their Slack messages to infer a high-quality skill list they likely possess.\n\nEvidence priority (highest to lowest):\n1) Profile fields authored by the person (expertise, projects, offers, most_interested_in)\n2) Consistent themes in their messages (deduplicated by thread)\n\nRules:\n- Output ONLY a JSON array of 5–25 concise high level skill strings (no objects, no extra text).\n- Prefer technical, domain, or tool-specific skills. Avoid common soft skills.\n- Avoid overly narrow/hyper-specific skills (e.g., prefer "Web / Frontend Development" over "CSS scroll-driven animations").\n- Deduplicate and sort by strength of evidence and recency.\n- If evidence is thin, return a smaller set (>=3 if possible).\n- The highest signal data is expertise, projects, offers, and most_interested_in.`;

    const payload = {
      profile: {
        name: person.name || undefined,
        expertise: person.expertise || undefined,
        projects: person.projects || undefined,
        offers: person.offers || undefined,
        asks: person.asks || undefined,
        most_interested_in: person.most_interested_in || undefined,
        confusion: person.confusion || undefined,
      },
      sample_messages: messages || [],
      example_skills_for_specificity_guidance: exampleSkills.slice(0, 100),
    };

    const resp = await this.openai.responses.create({
      model: "gpt-5-mini",
      input: `System Prompt\n\n${systemPrompt}\n\nUser Payload (JSON)\n\n${JSON.stringify(
        payload
      )}`,
      temperature: 1,
      max_output_tokens: 10000,
    });
    const content = (resp as any).output_text?.trim();
    if (!content) return [];
    try {
      capturePrompt?.(
        "person_skills",
        `PERSON SKILLS\n\nSystem\n${systemPrompt}\n\nPayload\n${JSON.stringify(
          payload,
          null,
          2
        )}\n\nOutput\n${content}`
      );
    } catch {}

    // Be robust to code fences
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      const cleaned = content
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "");
      parsed = JSON.parse(cleaned);
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s: any) => typeof s === "string" && s.trim().length > 0)
      .map((s: string) => s.trim());
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
    capturePrompt?: (type: string, content: string) => void;
  }): Promise<string> {
    const { needText, helper } = input;
    const systemPrompt =
      "You write crisp, evidence-based, highly specific bullets explaining why this teammate is a strong fit for the given request." +
      " Output exactly THREE bullet points as incomplete sentences, each starting with '- '." +
      " Do not include their name, pronouns, or @mentions (the name is shown elsewhere)." +
      " Use only information provided in the request and person fields; do not invent details." +
      " Prioritize concrete evidence: directly relevant skills/experience, notable projects or offers, or recent message themes." +
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
        channels: (helper.channels || [])
          .filter((c) => !isBlockedChannelName(c.channel_name))
          .map((c) => ({
            name: c.channel_name,
            summary: c.summary,
          })),
        sample_messages: (helper.messages || []).slice(-100),
      },
    };

    const resp = await this.openai.responses.create({
      model: "gpt-5-mini",
      input: `System Prompt\n\n${systemPrompt}\n\nUser Payload\n\n${JSON.stringify(
        userPayload
      )}`,
      temperature: 1,
      max_output_tokens: 10000,
    });
    const content = (resp as any).output_text?.trim() as string | undefined;
    if (!content) {
      throw new Error("No response text returned by gpt-5-mini (empty output)");
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

    try {
      input.capturePrompt?.(
        "fit_summary",
        `FIT SUMMARY\n\nSystem Prompt\n\n${systemPrompt}\n\nUser Payload\n\n${JSON.stringify(
          userPayload,
          null,
          2
        )}\n\nModel Raw Output\n\n${content}`
      );
    } catch {}

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

    const response = await this.openai.responses.create({
      model: "gpt-5-mini",
      input: `System Prompt\n\n${systemPrompt}\n\nUser Prompt\n\n${userPrompt}`,
      temperature: 1,
      max_output_tokens: 10000,
    });
    const content = (response as any).output_text?.trim() || "";

    const summary = content
      .split("\n")
      .filter((line: string) => line.trim().length > 0)
      .join(" ");
    return { summary, model };
  }
}

export const channelSummarizerService = new ChannelSummarizerService();
