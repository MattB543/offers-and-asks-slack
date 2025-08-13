import * as fs from "fs";
import * as path from "path";
import { db } from "../lib/database";
import { SEARCH_CONFIG } from "../config/searchConfig";
import { spawn } from "child_process";

export interface Bm25Doc {
  id: string; // Composite doc id: `${channel_id}:${ts}`
  channel_id: string | null;
  channel: string | null;
  username: string | null;
  text: string;
  thread_ts?: string | null;
  ts?: string | null;
}

export class Bm25IndexService {
  private corpusPath = SEARCH_CONFIG.bm25.corpusJsonPath;

  async exportCorpus(): Promise<number> {
    const res = await db.query(
      `SELECT m.id,
              m.channel_id,
              m.channel_name AS channel,
              COALESCE(p.display_name, m.user_id) AS username,
              m.text,
              m.thread_ts,
              m.ts
       FROM slack_message m
       LEFT JOIN LATERAL (
         SELECT display_name
         FROM people
         WHERE slack_user_id = m.user_id
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1
       ) p ON true
       WHERE m.text IS NOT NULL
         AND COALESCE(m.subtype,'') NOT IN (
           'channel_join','channel_leave','bot_message','message_changed','message_deleted',
           'thread_broadcast','file_share','channel_topic','channel_purpose','channel_name',
           'channel_archive','channel_unarchive','group_join','group_leave'
         )
       ORDER BY m.id ASC`
    );

    const docs: Bm25Doc[] = (res.rows as any[]).map((r) => {
      const channelId: string | null = r.channel_id || null;
      const ts: string | null = r.ts || null;
      const compositeId = channelId && ts ? `${channelId}:${ts}` : String(r.id);
      return {
        id: compositeId,
        channel_id: channelId,
        channel: r.channel,
        username: r.username,
        text: r.text?.slice(0, 4000) || "",
        thread_ts: r.thread_ts,
        ts,
      } as Bm25Doc;
    });

    fs.mkdirSync(path.dirname(this.corpusPath), { recursive: true });
    fs.writeFileSync(this.corpusPath, JSON.stringify({ docs }), "utf8");
    return docs.length;
  }

  async rebuildIndex(): Promise<void> {
    const count = await this.exportCorpus();
    await new Promise<void>((resolve, reject) => {
      const py = spawn(
        SEARCH_CONFIG.python.executable,
        [
          `${SEARCH_CONFIG.python.scriptsDir}/bm25_index.py`,
          "build",
          "--corpus",
          this.corpusPath,
          "--index",
          SEARCH_CONFIG.bm25.indexPath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      py.stdout.on("data", (d) => process.stdout.write(d));
      py.stderr.on("data", (d) => process.stderr.write(d));
      py.on("error", reject);
      py.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`bm25 build exited ${code}`))
      );
    });
    try {
      await db.upsertIndexMetadata("bm25", count);
    } catch {}
  }
}

export const bm25IndexService = new Bm25IndexService();
