Below is a **battle-tested MVP blueprint** for your “weekly helper-matcher” Slack app, with _every_ step cross-checked against official docs or reputable guides. In short, you’ll run a Bolt-for-JS app behind the Events API, store skills and OpenAI embeddings in a DigitalOcean Postgres cluster with **pgvector**, and trigger a Bree cron job every Monday 09:00 ET to collect needs, rank helpers by cosine similarity, and DM the suggestions back.

---

## 1. Architecture at a glance

| Concern               | Choice                                                                    | Why                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Slack integration** | **Bolt for JS** on **Events API**                                         | Official framework; Events API only needs one public URL and works in any workspace (no App Directory listing) ([Slack Developer Tools][1], [Slack API][2]) |
| **Job scheduler**     | **Bree** cron job                                                         | Tiny dependency, human-readable cron, proven in Node micro-services ([GitHub][3], [LogRocket Blog][4])                                                      |
| **Database**          | **DigitalOcean Managed Postgres 15 + pgvector**                           | pgvector now pre-installed on DO clusters; you can enable with `CREATE EXTENSION IF NOT EXISTS vector` ([DigitalOcean Ideas][5], [DigitalOcean Docs][6])    |
| **Similarity search** | `vector <=> query` (cosine) with optional HNSW index                      | pgvector supports cosine and approximate HNSW indexes for speed ([GitHub][7], [GitHub][7])                                                                  |
| **Embeddings**        | `text-embedding-3-small` via OpenAI Node SDK                              | Cheapest current model, same 1 × 1536-dim vector as larger sibling ([OpenAI Platform][8], [OpenAI Platform][9])                                             |
| **Hosting**           | • **DO App Platform “Starter”** \$3/mo <br>• **Heroku Hobby dyno** \$7/mo | Both handle Node apps + Postgres; DO is cheaper, Heroku still fine if you like buildpacks ([DigitalOcean][10], [help.heroku.com][11])                       |
| **Notifications**     | DM admin on caught errors                                                 | Send via `conversations.open` + `chat.postMessage` ([Slack API][12], [Slack API][13])                                                                       |

---

## 2. Slack-side setup

### 2.1 Create & configure the app

1. **Create a new app** in your workspace (no distribution needed).

2. **Turn on Event Subscriptions** → set **Request URL** (e.g., `https://YOUR-APP.onrender.com/slack/events`) – Slack must reach it to verify the endpoint ([Slack API][14], [Slack Developer Tools][15]).

3. Subscribe to:

   - `app_home_opened`, `message.im`, `block_actions`, `view_submission`.

4. **OAuth scopes** (minimum):

   | Scope                | Reason                                   |
   | -------------------- | ---------------------------------------- |
   | `chat:write`         | Send DMs & suggestions ([Slack API][13]) |
   | `chat:write.public`  | Allow posting to unknown IMs             |
   | `conversations:open` | Start a DM ([Slack API][12])             |
   | `commands`           | Optional future `/helpme`                |
   | `users:read`         | Pull display names & de-dupe skills      |
   | `links.embed:write`  | (only if you later add unfurls)          |

5. Generate one **Bot token** and one **Signing Secret**; store both in `.env`.

### 2.2 Bolt skeleton (TypeScript/JS)

```ts
import { App } from "@slack/bolt";
import Bree from "bree";
import { Client as PG } from "pg";
import OpenAI from "openai";

const app = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  token: process.env.SLACK_BOT_TOKEN,
});

// Bree: Monday 09:00 ET (“0 0 9 * * 1” in New York TZ)
const bree = new Bree({
  jobs: [
    {
      name: "weekly_prompt",
      cron: "0 0 9 * * 1",
      tz: "America/New_York",
    },
  ],
});
```

_(Full handlers in later sections.)_

---

## 3. Data layer

### 3.1 Provision Postgres with pgvector

_Create cluster_ → **Settings → Extensions → Enable `vector`** ([DigitalOcean Ideas][5]).

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE people (
  slack_id TEXT PRIMARY KEY,
  display_name TEXT,
  enabled BOOLEAN DEFAULT TRUE
);

CREATE TABLE skills (
  id SERIAL PRIMARY KEY,
  skill TEXT NOT NULL,
  embedding vector(1536)
);

CREATE TABLE person_skills (
  slack_id TEXT REFERENCES people,
  skill_id INT REFERENCES skills
);
```

### 3.2 Seed skills from `.csv`

Parse with `fast-csv` and bulk-insert (`COPY` or batched `INSERT`). Each unique _skill text_ gets one row and an embedding:

```ts
const { data } = await openai.embeddings.create({
  model: "text-embedding-3-small",
  input: skillText,
});
await pg.query("UPDATE skills SET embedding=$1 WHERE id=$2", [
  data[0].embedding,
  skillId,
]);
```

([OpenAI Platform][9])

_Tip_: add an **HNSW index** later for O( log N ) lookups:

````sql
CREATE INDEX ON skills USING hnsw (embedding vector_cosine_ops);
``` :contentReference[oaicite:12]{index=12}

---

## 4. Weekly DM workflow

### 4.1 Scheduling & DM prompt
* `weekly_prompt.js` Bree worker:

```ts
import { app, pg, openai } from '../lib/clients.js';

const res = await pg.query(
  'SELECT slack_id FROM people WHERE enabled = TRUE');
for (const { slack_id } of res.rows) {
  // open DM and send prompt with “Need help?” button
  const dm = await app.client.conversations.open({ users: slack_id });
  await app.client.chat.postMessage({
    channel: dm.channel.id,
    text: 'What do you need help with this week?',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn',
        text: '*What do you need help with this week?*' } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Tell me' },
          action_id: 'open_need_modal' }
      ]}
    ]
  });
}
````

`conversations.open` & `chat.postMessage` usage per Slack docs ([Slack API][12], [Slack API][13]).

### 4.2 Intake modal

In your `app.action('open_need_modal', …)` handler, call `views.open` with a single `plain_text_input` element ([Slack API][16], [Slack Developer Tools][17]).
Capture the submitted text in `view_submission`.

### 4.3 Matching helpers

For the submitted need:

```ts
const embedding = (
  await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: need,
  })
).data[0].embedding;

// cosine similarity (higher = closer)
const { rows } = await pg.query(
  `
  SELECT p.slack_id, p.display_name,
         s.skill,
         1 - (s.embedding <=> $1::vector) AS score
  FROM skills s
  JOIN person_skills ps USING (skill_id)
  JOIN people p USING (slack_id)
  WHERE p.enabled = TRUE
  ORDER BY score DESC
  LIMIT 20
`,
  [embedding]
);

// aggregate top helpers
const topHelpers = [];
for (const row of rows) {
  const entry =
    topHelpers.find((h) => h.id === row.slack_id) ??
    topHelpers[
      topHelpers.push({
        id: row.slack_id,
        name: row.display_name,
        skills: [],
      }) - 1
    ];
  if (entry.skills.length < 3) entry.skills.push(row.skill);
  if (topHelpers.length === 5) break;
}
```

Query pattern matches pgvector cosine docs ([GitHub][7]).

### 4.4 Deliver suggestions

Compose a DM:

```
Here are 🖐️ people who might help:

• *Aly* – React, Storybook
• *Dev* – Postgres perf, Indexing
• *Kim* – LangChain
```

---

## 5. Admin & error handling

Wrap every Slack/Web/DB call in `try/catch`. On error:

```ts
await app.client.chat.postMessage({
  channel: process.env.ADMIN_USER_ID,
  text: `Helper-bot error: ${err.message}`,
});
```

---

## 6. Deployment & ops

| Option                        | Monthly cost                                     | Steps                                                                     |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| **DO App Platform “Starter”** | **\$3** (600 MiB/1 vCPU) ([DigitalOcean][10])    | Connect GitHub → set env vars → auto-deploy                               |
| **Heroku Hobby**              | **\$7** (512 MiB/1 dyno) ([help.heroku.com][11]) | Add buildpack `heroku/nodejs`, provision Heroku Postgres _or_ point to DO |

Both expose HTTPS, satisfying Events API’s public URL requirement ([Slack API][2]).

---

## 7. Nice-to-haves (post-MVP)

- **Slash-command `/helpme`** for on-demand matching.
- **`chat.scheduleMessage`** instead of Bree if you later want Slack-native scheduling (but note one-shot nature) ([Slack API][18]).
- **Approximate HNSW index** once skills grow past a few thousand for sub-50 ms queries ([Google Cloud][19]).
- **Toggle**: let users pause the bot via home-tab checkbox.
