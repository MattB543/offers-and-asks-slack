import { config } from "dotenv";
config();
import * as fs from "fs";
import * as path from "path";
import { db } from "../lib/database";
import { embeddingService } from "../lib/openai";

type Capture = { type: string; content: string };

async function pickTopMessageSender(): Promise<string | null> {
  const res = await db.query(
    `SELECT p.user_id
     FROM people p
     JOIN slack_message m ON m.user_id = p.slack_user_id
     GROUP BY p.user_id
     ORDER BY COUNT(m.id) DESC
     LIMIT 1`
  );
  return res.rows[0]?.user_id || null;
}

async function auditUser(userId: string, apply: boolean): Promise<string> {
  const person = await db.getPerson(userId);
  if (!person) throw new Error(`Person not found: ${userId}`);
  const slackId: string = person.slack_user_id || person.user_id;

  const beforeSkills = await db.getPersonSkills(userId);
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

  const captures: Capture[] = [];
  // Provide global skills for specificity guidance
  const globalSkillNames = await db.getAllSkillNames();

  const inferred = await embeddingService.extractPersonSkills({
    person: profile,
    messages,
    exampleSkills: globalSkillNames,
    capturePrompt: (type, content) => captures.push({ type, content }),
  });

  let wroteCount = 0;
  if (apply && inferred.length > 0) {
    await db.clearPersonSkills(userId);
    for (const skill of inferred) {
      try {
        let rec = await db.getSkillByText(skill);
        if (!rec) {
          const id = await db.createSkill(skill);
          const emb = await embeddingService.generateEmbedding(skill);
          await db.updateSkillEmbedding(id, emb);
          rec = { id, skill } as any;
        }
        await db.addPersonSkill(userId, rec.id);
        wroteCount += 1;
      } catch {}
    }
  }

  const afterSkills = apply ? await db.getPersonSkills(userId) : beforeSkills;

  // Compute proposed additions (not applied when apply=false)
  const beforeSet = new Set(
    beforeSkills.map((s: any) => String(s.skill).toLowerCase())
  );
  const proposedNew = inferred.filter(
    (s) => !beforeSet.has(String(s).toLowerCase())
  );

  const auditsDir = path.join(process.cwd(), "audits");
  if (!fs.existsSync(auditsDir)) fs.mkdirSync(auditsDir, { recursive: true });
  const filePath = path.join(
    auditsDir,
    `audit_person_${userId}_${Date.now()}.txt`
  );

  const payloadJson = JSON.stringify(
    { profile, sample_messages: messages.slice(-150) },
    null,
    2
  );

  const lines: string[] = [];
  lines.push("=== Audit: Person Skill Rebuild ===");
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("-- Person --");
  lines.push(`user_id: ${person.user_id}`);
  lines.push(`slack_user_id: ${slackId}`);
  lines.push(`display_name: ${person.display_name}`);
  lines.push(`enabled: ${person.enabled}`);
  lines.push("");
  lines.push("-- Profile fields --");
  lines.push(`most_interested_in: ${person.most_interested_in || ""}`);
  lines.push(`confusion: ${person.confusion || ""}`);
  lines.push(`expertise: ${person.expertise || ""}`);
  lines.push(`projects: ${person.projects || ""}`);
  lines.push(`asks: ${person.asks || ""}`);
  lines.push(`offers: ${person.offers || ""}`);
  lines.push("");
  lines.push("-- Messages (up to 200, formatted with thread context) --");
  lines.push(`count: ${messages.length}`);
  lines.push(...messages.map((m) => `- ${m}`));
  lines.push("");
  lines.push("-- Existing skills (before) --");
  lines.push(
    beforeSkills.length
      ? beforeSkills.map((s: any) => `- ${s.skill}`).join("\n")
      : "(none)"
  );
  lines.push("");
  lines.push(
    "-- Model Input JSON (profile + sample_messages + example_skills_for_specificity_guidance) --"
  );
  lines.push(payloadJson);
  lines.push("");
  lines.push("-- Model Captures --");
  for (const c of captures) {
    lines.push(`>> ${c.type}`);
    lines.push(c.content);
    lines.push("");
  }
  lines.push("-- Parsed inferred skills --");
  lines.push(inferred.length ? inferred.map((s) => `- ${s}`).join("\n") : "[]");
  lines.push("");
  lines.push(`-- Applied to DB: ${apply}`);
  if (apply) {
    lines.push(`skills_written: ${wroteCount}`);
  }
  lines.push("");
  if (!apply) {
    lines.push("-- Proposed new skills (not applied) --");
    lines.push(
      proposedNew.length
        ? proposedNew.map((s) => `+ ${s}`).join("\n")
        : "(none)"
    );
    lines.push("");
  }
  lines.push(
    `-- Skills (after${apply ? "" : " - unchanged (no --apply)"} ) --`
  );
  lines.push(
    afterSkills.length
      ? afterSkills.map((s: any) => `- ${s.skill}`).join("\n")
      : "(none)"
  );

  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  return filePath;
}

async function main() {
  try {
    const ok = await db.healthCheck();
    if (!ok) throw new Error("Database not reachable");

    const args = process.argv.slice(2);
    const userArg = args.find((a) => !a.startsWith("--"));
    const apply = args.includes("--apply");
    let target = userArg || null;
    if (!target) {
      target = await pickTopMessageSender();
      if (!target) throw new Error("Could not pick a user with messages");
    }

    const filePath = await auditUser(target, apply);
    console.log(`✅ Audit written to: ${filePath}`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Audit failed:", err);
    process.exit(1);
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main();
}
