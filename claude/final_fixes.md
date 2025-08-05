### 🚦 Final pre-flight checklist

Everything is **much** tighter than last time — nice work. I ran through the repo as if I were the build server, the database, and Slack, and only a handful of loose screws are still rattling around.

| ✅ / ❌ | Area                      | What I checked                                                                                                                                                    | Status & next action                                                                                                                                         |
| ------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ✅      | Duplicate source files    | `src/` now contains \*_only _.ts\*\*; no stray \*.js / \*.d.ts.                                                                                                   | Perfect.                                                                                                                                                     |
| ✅      | Slack manifest            | `im:write`, `home_tab_enabled:true`, events list present.                                                                                                         | Good to import straight into Slack.                                                                                                                          |
| ✅      | Cron strings              | Both `server.ts` _and_ `weekly-prompt.ts` use `0 9 * * 1` (Mon 09:00 ET).                                                                                         | Synced.                                                                                                                                                      |
| ✅      | Vector **casts**          | All writes/read queries use `::vector` and cosine operator.                                                                                                       | Implementation-wise correct.                                                                                                                                 |
| ❌      | **schema.sql**            | `db.initializeSchema()` still points to `database/schema.sql`, but that file isn’t in the tree.                                                                   | Add it (include `CREATE EXTENSION IF NOT EXISTS vector;` plus your tables).                                                                                  |
| ❌      | Build in production       | App Platform / Heroku will run `npm start` only → the compiled `dist/` folder doesn’t exist yet.                                                                  | • Simplest: change `run_command` in `.do/app.yaml` to `npm run build && npm start`.<br>• Or add `prestart": "npm run build"` in `package.json`.              |
| ⚠️      | DevDeps at build          | `typescript`, `ts-node` live in **devDependencies**. Platforms that set `NODE_ENV=production` during `npm install` will skip them (and the build step will fail). | Either move `typescript` & `ts-node` to `dependencies`, or rely on the build step above which runs during the _build_ image where devDeps are still present. |
| ⚠️      | Vector **payload format** | `updateSkillEmbedding()` & friends pass a raw JS `number[]` into `$1::vector`. `pg` stringifies this to `"{1,2,3}"`, which pgvector **can’t parse**.              | Convert before send:<br>`const vec = embedding.join(',');` → pass `vec` (or use `pgvector` npm package). Do the same for weekly needs.                       |
| ⚠️      | Health-check cost         | `embeddingService.healthCheck()` calls OpenAI on every boot; that’s a paid API hit.                                                                               | Consider mocking (e.g. `if NODE_ENV!=="production"`) or hitting `/models` instead of an embedding.                                                           |
| 🟡      | `.gitignore`              | `dist/`, `src/**/*.js`, `src/**/*.d.ts` still not ignored.                                                                                                        | Add so you don’t accidentally commit artefacts again.                                                                                                        |

---

#### One-liner fixes

```bash
# 1. Add the schema file
mkdir -p database && ${EDITOR:-nano} database/schema.sql   # paste DDL

# 2. Ensure build step in prod
npm pkg set scripts.prestart="npm run build"

# 3. Handle vector payloads (database.ts – two spots shown)
sed -i 's/embedding, skillId/embedding.join(\",\"), skillId/' src/lib/database.ts
sed -i 's/needEmbedding, weekStart/needEmbedding.join(\",\"), weekStart/' src/lib/database.ts

# 4. Ignore build artefacts
echo -e "dist/\nsrc/**/*.js\nsrc/**/*.d.ts" >> .gitignore
```

---

### TL;DR

_You’re 95 % there._
Add **schema.sql**, wire a **build step** for production, stringify the **vector** parameters, and you should be able to push → deploy → click “Install” in Slack without the container falling over.

Let me know when you’ve patched those and I’ll give it one more pass!
