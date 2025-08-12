import { config } from "dotenv";
config();
import { db } from "../lib/database";
import { embeddingService } from "../lib/openai";

async function rebuildPersonSkillsForUser(userId: string): Promise<{
  userId: string;
  added: number;
}> {
  const person = await db.getPerson(userId);
  if (!person) throw new Error(`Person not found: ${userId}`);

  const slackId: string = person.slack_user_id || person.user_id;

  // Gather context
  const messages = await db.getUserMessagesAll(slackId);
  const profile = {
    name: person.display_name as string | null,
    expertise: person.expertise as string | null,
    projects: person.projects as string | null,
    offers: person.offers as string | null,
    asks: person.asks as string | null,
    most_interested_in: person.most_interested_in as string | null,
    confusion: person.confusion as string | null,
  };

  // Ask LLM to infer skills from profile + messages
  // Provide global skill vocabulary as specificity anchor
  const globalSkillNames = await db.getAllSkillNames();

  const inferred = await embeddingService.extractPersonSkills({
    person: profile,
    messages,
    exampleSkills: globalSkillNames,
  });

  // If we inferred nothing, keep existing skills
  if (!Array.isArray(inferred) || inferred.length === 0) {
    console.log(
      `ℹ️  No inferred skills for ${userId}; leaving existing skills unchanged.`
    );
    return { userId, added: 0 };
  }

  // Only add new skills; do not remove existing
  const existing = await db.getPersonSkills(userId);
  const existingSet = new Set<string>(
    existing.map((s: any) => s.skill.toLowerCase())
  );

  let added = 0;
  for (const skill of inferred) {
    try {
      if (existingSet.has(skill.toLowerCase())) {
        continue;
      }
      let rec = await db.getSkillByText(skill);
      if (!rec) {
        const id = await db.createSkill(skill);
        const emb = await embeddingService.generateEmbedding(skill);
        await db.updateSkillEmbedding(id, emb);
        rec = { id, skill } as any;
      }
      await db.addPersonSkill(userId, rec.id);
      added += 1;
    } catch (e) {
      console.warn(`Failed to add skill "${skill}" for ${userId}:`, e);
    }
  }

  return { userId, added };
}

async function main() {
  try {
    // Ensure DB is reachable
    const ok = await db.healthCheck();
    if (!ok) throw new Error("Database not reachable");

    const arg = process.argv[2];
    if (arg && arg !== "--all") {
      const res = await rebuildPersonSkillsForUser(arg);
      console.log(`✅ Rebuilt skills for ${res.userId}; added ${res.added}`);
      process.exit(0);
    }

    const people = await db.getAllEnabledPeople();
    console.log(`👥 Rebuilding skills for ${people.length} enabled people...`);

    let totalAdded = 0;
    for (const p of people) {
      try {
        const res = await rebuildPersonSkillsForUser(p.user_id);
        totalAdded += res.added;
        // Small delay to be polite to rate limits
        await new Promise((r) => setTimeout(r, 150));
      } catch (e) {
        console.warn(`⚠️  Failed for ${p.user_id}:`, e);
      }
    }

    console.log(`🎉 Done. Total skills added: ${totalAdded}`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Job failed:", err);
    process.exit(1);
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main();
}

export { rebuildPersonSkillsForUser };
