### 🔍 Key things that still need a quick tune-up

| Area                              | What you shipped                                                                                                                                              | Why it matters                                                                                                                                                                                                                                                   | Fix in one line                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Scopes**                        | Manifest has `chat:write` but not **`im:write`**                                                                                                              | `conversations.open` (used all over for DMs) won’t work without it ([Slack API][1])                                                                                                                                                                              | Add `"im:write"` to `oauth_config.scopes.bot`                                            |
| **App Home flags**                | `home_tab_enabled` is **false** by default                                                                                                                    | Your code builds a Home tab every `app_home_opened` event; Slack will ignore it unless the flag is on ([Slack API][2])                                                                                                                                           | `"features": { "app_home": { "home_tab_enabled": true, "messages_tab_enabled": false }}` |
| **Events**                        | Manifest doesn’t list any events                                                                                                                              | You call `message.im`, `app_home_opened`, plus block/modals. Add under `settings.event_subscriptions.bot_events`.                                                                                                                                                |                                                                                          |
| **DigitalOcean envs**             | `.do/app.yaml` uses `value: ${XYZ}` placeholders                                                                                                              | App Platform treats that as a **literal** string. Use either a real value or<br>`value: "" type: SECRET` and set the secret in the control-panel, or reference a DO-managed database via `db_connection`. Spec shows the accepted shape ([DigitalOcean Docs][3]) |                                                                                          |
| **Seed script in postdeploy**     | `npm run seed-skills seed-sample`                                                                                                                             | npm only forwards args with `--`; else they’re swallowed. Use `npm run seed-skills -- seed-sample`.                                                                                                                                                              |                                                                                          |
| **Schema file**                   | `db.initializeSchema()` expects `database/schema.sql`, but that file isn’t in the repo snapshot                                                               | Add the SQL file (including `CREATE EXTENSION IF NOT EXISTS vector`) or the build will fail.                                                                                                                                                                     |                                                                                          |
| **Cron string**                   | You fixed it to `0 9 * * 1` (👍). Just make sure _all_ Bree configs use the 5-field form; the compiled JS still had the earlier 6-field version in one place. |                                                                                                                                                                                                                                                                  |                                                                                          |
| **Vector storage** (nice-to-have) | Embeddings are written with `JSON.stringify`, later cast to `vector`                                                                                          | Accepted by pgvector, but sending the **raw float\[]** (or using npm `pgvector`) shaves a tiny parse cost.                                                                                                                                                       |                                                                                          |
| **Unused import**                 | `express` is imported in `server.ts` but never used                                                                                                           | Safe to delete.                                                                                                                                                                                                                                                  |                                                                                          |

---

### 📜 Updated minimal manifest (JSON)

```jsonc
{
  "display_information": { "name": "Offers & Asks" },

  "features": {
    "app_home": {
      "home_tab_enabled": true,
      "messages_tab_enabled": false
    },
    "bot_user": { "always_online": true }
  },

  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "im:write",
        "conversations.open",
        "users:read",
        "channels:read"
      ]
    }
  },

  "settings": {
    "event_subscriptions": {
      "request_url": "https://YOUR-DOMAIN/slack/events",
      "bot_events": ["app_home_opened", "message.im"]
    },
    "interactivity": {
      "is_enabled": true,
      "request_url": "https://YOUR-DOMAIN/slack/events"
    },
    "socket_mode_enabled": false
  }
}
```

_(Add any extra scopes you decide to use later—e.g., `commands` for a future `/helpme` slash command.)_

---

### ✅ Everything else looks solid

- **Cron @ 09:00 ET on Mondays** is now correct and Bree is time-zoned.
- Your **pgvector queries** (`1 - (embedding <=> $1::vector)`) match the docs.
- Worker pattern that instantiates a fresh `App` inside Bree jobs is valid (Bolt runs fine without `.start()` when you only need `client`).
- Health-checks, error DM to `ADMIN_USER_ID`, and structured `ErrorHandler` show good production hygiene.
- TypeScript config builds to `dist/` and Bree’s `root` points there, so compiled jobs will load.

Ship the tweaks above and you should be able to click “Install app” and see the Home tab plus Monday DM working on the first try. 💪
