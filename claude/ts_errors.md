Below is a quick “sanity audit” of the repo. I focused on ⚠️ red-flag items that will break a deploy, 🌀 sources of confusion (mostly file duplication), and a few ✂️ safe-to-prune leftovers. Nothing here rewrites business logic—just housekeeping so the code you already wrote actually runs.

---

## 1 ️⃣ Why the container dies at runtime

| Symptom                                                                             | Root cause                                                                                                                                                                                                                                                                 | How to fix                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`ERR_MODULE_NOT_FOUND: …  /dist/lib/database`** when `node dist/server.js` starts | Node is running in **ES-module mode** (because you are on Node ≥ 20 _and_ there is no `"type": "commonjs"` in `package.json`).<br>In ESM, an `import "./lib/database"` _must_ include the file-extension. The compiled `dist/app.js` _omits_ it, so the resolver gives up. | _Quick_: add `"type": "commonjs"` in `package.json` so Node treats the whole tree as CJS.<br>_or_ switch the project to ESM (`"module": "NodeNext"` in `tsconfig.json`, use native `import` _with extensions_, update `require()` calls). |
| **`/workspace/dist/lib/database.js` is missing** (if you inspect the image)         | `tsc` never emitted it because the build failed earlier, _but you didn’t see it_ during `npm run build`. The culprit is duplicated source files (see §2).                                                                                                                  | Remove the compiled `.js` / `.d.ts` files that live **inside `src/`**; they collide with the `.ts` compiler when incremental builds run.                                                                                                  |

---

## 2 ️⃣ File-duplication matrix (what to delete vs. keep)

| Path                         |    Keep?    | Reason                                                                                                                     |
| ---------------------------- | :---------: | -------------------------------------------------------------------------------------------------------------------------- |
| `src/**/*.ts`                |     ✅      | Authoritative source code.                                                                                                 |
| `src/**/*.js`                |     ❌      | These are _checked-in_ transpiled artifacts. They confuse `ts-node` in dev and collide with `tsc` on incremental builds.   |
| `src/**/*.d.ts`              |     ❌      | Also transpiled artifacts; same problem. Your `"declaration": true` option means they’ll be regenerated in `dist/` anyway. |
| `dist/**`                    |     🟡      | **Keep locally, ignore in git**. Add `dist/` to `.gitignore`; CI/build servers should generate it every time.              |
| `claude/*.md` planning files |     ✅      | Documentation only—fine to keep.                                                                                           |
| `database/schema.sql`        | **MISSING** | `db.initializeSchema()` reads this file. Add it (or point the code to the right path).                                     |

**One-liner:**

```bash
# .gitignore (add)
dist/
src/**/*.js
src/**/*.d.ts
```

---

## 3 ️⃣ Code-level nits that will bite later

| Area                              | Snippet to change                                                                                | Why / How                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Vector columns**                | `UPDATE skills SET embedding = $1 WHERE id = $2`                                                 | Postgres needs a cast when you pass an array literal: `…SET embedding = $1::vector…`. Even better: use `pgvector`’s Node binding so parameters are sent as binary. |
| **`findSimilarHelpers` param**    | Current JS version stringifies the embedding, TS version doesn’t.                                | Pick one convention (pass the raw float\[] and cast with `::vector`) and delete the other implementation.                                                          |
| **Cron expression drift**         | You fixed the TS job to `0 9 * * 1` but the compiled JS file still shows the old 6-field string. | After wiping `src/**/*.js`, this inconsistency disappears.                                                                                                         |
| **Post-deploy seed script**       | `"postdeploy": "npm run seed-skills seed-sample"`                                                | Needs the `--` delimiter: `"postdeploy": "npm run seed-skills -- seed-sample"`.                                                                                    |
| **DigitalOcean env placeholders** | `.do/app.yaml` has `value: ${DATABASE_URL}` etc.                                                 | App Platform treats those as _literal text_. Use `value: ""` + `type: SECRET` and set the secret in the dashboard.                                                 |

---

## 4 ️⃣ Slack-App manifest & scopes

You already captured these in `claude/fixes.md`; just be sure the single source-of-truth is **`slack-app-manifest.json`** and update it in the Slack UI:

- add `"im:write"` (required for `conversations.open`)
- flip `home_tab_enabled` to `true`
- list the events you subscribe to (`app_home_opened`, `message.im`, etc.)

No code changes needed if you merge those fixes.

---

## 5 ️⃣ Suggested “house-clean” commit

```bash
# 1. Remove compiled artefacts from the source tree
git rm -r src/**/*.js src/**/*.d.ts

# 2. Ignore build output
echo -e "dist/\nsrc/**/*.js\nsrc/**/*.d.ts" >> .gitignore

# 3. Lock repo to CommonJS (or convert to ESM – pick ONE)
npm pkg set type=commonjs

# 4. Patch small config errors
#   a) Post-deploy script
sed -i 's/seed-skills seed-sample/seed-skills -- seed-sample/' app.json
#   b) cron already fixed in TS; JS file gone after step 1
#   c) add schema.sql
mkdir -p database && touch database/schema.sql  # then paste your DDL

# 5. Rebuild & test
npm run build && node dist/server.js
```

After that, redeploy. The container should boot, `/health` should be green, and Slack should verify the Event API URL.

---

### TL;DR

- Delete the compiled `.js` + `.d.ts` files in **`src/`**—they’re the source of most headaches.
- Decide on CommonJS **or** ESM and configure `package.json`/`tsconfig.json` consistently.
- Add the missing `schema.sql` file and the `::vector` cast when writing embeddings.
- Merge the tiny manifest / cron / postdeploy tweaks already noted.

Once those are in place the project is lean (no extra functions) and should run cleanly both locally and in production. 🚀
