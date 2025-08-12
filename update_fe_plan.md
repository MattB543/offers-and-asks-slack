## Frontend plan: full Slack thread context across routes

This document explains how the FE should retrieve and render full thread context for search results, links, and ad-hoc thread fetches using the updated APIs.

### Goals

- Always allow the FE to reconstruct the full Slack thread when a message hit belongs to a thread.
- Avoid redundant network requests by deduping/caching per-thread.
- Keep payloads reasonable by supporting both eager and lazy thread loading.

## Endpoints and behavior

- POST `\/api\/search`

  - Purpose: semantic message search
  - Request: `{ query: string, topK?: number, channels?: string[], dateFrom?: string, dateTo?: string, includeThreads?: boolean }`
    - `includeThreads`: default true. If true, results include the full thread for each hit.
  - Response (per result):
    - Base fields: `id, channel_id, channel_name, user_id, ts, thread_ts, parent_ts, is_reply, text, author, score`
    - Thread metadata: `thread_root_ts` (computed), `in_thread` (boolean)
    - Thread payload (when `includeThreads !== false`): `thread: Array<{ id, channel_id, channel_name, user_id, ts, text, author }>` ordered by `ts` asc

- GET `\/api\/links`

  - Purpose: extract links from messages, with optional thread context
  - Query params: `channel_id?, user_id?, dateFrom?, dateTo?, limit?, offset?, includeThreads?`
    - `includeThreads`: default false (enable for full threads)
  - Response (per row):
    - Base: `message_id, channel_id, channel_name, user_id, author, ts, thread_ts, parent_ts, url`
    - Thread metadata: `thread_root_ts`, `in_thread`
    - Optional: `thread` when `includeThreads=true`, same shape/order as search

- GET `\/api\/thread`

  - Purpose: lazy-load a full thread by root
  - Query params: `channel_id`, `root_ts`
  - Response: `{ ok, channel_id, thread_root_ts, messages: Array<{ id, channel_id, channel_name, user_id, ts, text, author }>} (ordered by ts asc)`

- POST `\/api\/summarize`
  - Unchanged: given `messageIds`, returns `{ summary }`. If you want summaries to include thread context, the FE should gather intended message IDs (possibly by expanding to their thread roots and fetching via `\/api\/thread`) and decide how to present or pre-process before calling summarize. If needed later we can add `expandThreads` server-side.

## FE implementation guidelines

### 1) Canonical thread key and dedupe

- Compute a unique key per thread: `${channel_id}:${thread_root_ts}`.
- Maintain an in-memory map: `threadKey -> { messages, lastFetchedAt }`.
- Before adding a fetched thread, dedupe messages by `id` and sort by ascending `ts`.

### 2) Search results

- Call `\/api\/search` with `includeThreads: true` for the simplest UX.
- For each result:
  - Use `thread_root_ts` and `channel_id` to index/cache the thread.
  - Render a collapsed thread preview where the hit message is highlighted.
  - If payload size is a concern, request with `includeThreads: false` and lazy-load only visible threads using `\/api\/thread` when the user expands a result.

Example request:

```json
{
  "query": "evaluation",
  "topK": 20,
  "includeThreads": true
}
```

### 3) Links view

- By default, request without threads and show a flat list.
- When the user expands a row (or for on-hover preview), either:
  - Reuse an already cached thread by `channel_id + thread_root_ts`, or
  - Call `\/api\/thread?channel_id=...&root_ts=...` and cache it.
- If you need all threads eagerly (heavier), call `\/api\/links?includeThreads=true` and cache them.

### 4) Summarize workflow (optional thread expansion)

- If the FE allows selecting messages for summary:
  - Expand selected messages to their thread roots (using `thread_root_ts` from search/links). Optionally fetch `\/api\/thread` to display context pre-summary.
  - You can either:
    - Send only the selected `messageIds` to `\/api\/summarize` (current behavior), or
    - Build a richer client-side view that shows the thread context alongside the returned summary.
- If later we want server-side thread expansion for summaries, we can add an `expandThreads` flag.

### 5) Rendering and UX

- Show thread header with `#channel_name` and root author; messages sorted by `ts` ascending.
- Highlight matched snippet within the thread (originating `id`/`ts`).
- Collapse long threads by default (e.g., show first 3 messages and the hit ±1), with an expand control for the full view.

### 6) Performance guidance

- Use eager threads for topK ≤ 20; otherwise prefer lazy `\/api\/thread` loads.
- Cache by thread key during the session; avoid re-fetching the same thread.
- The server truncates `text` differently by context:
  - Search row: `LEFT(text, 300)`
  - Thread payload via search/links: `LEFT(text, 1000)`
  - `\/api\/thread`: `LEFT(text, 4000)` for deeper detail
- If you need the longer variant for a given thread, prefer fetching via `\/api\/thread` once and replacing the cached entry.

### 7) Edge cases and ordering

- `ts` is a string; sort numerically by `parseFloat(ts)`.
- Messages with Slack `subtype='channel_join'` are excluded by the server.
- `author` falls back to Slack user ID if no display name.
- Threads include the root and all replies where `(ts = root_ts OR parent_ts = root_ts OR thread_ts = root_ts)`.

### 8) Auth and CORS

- If `EXTERNAL_POST_BEARER_TOKEN` or `BEARER_TOKEN` is set on the server, the FE must include an `Authorization: Bearer <token>` header for `\/api/*` routes.
- CORS allowlist is configured via env; ensure the FE origin is allowed or use the same origin in development.

## Reference shapes

Search result (per item):

```json
{
  "id": 123,
  "channel_id": "C123",
  "channel_name": "project-x",
  "user_id": "U123",
  "ts": "1712345678.000100",
  "thread_ts": "1712345600.000000",
  "parent_ts": null,
  "is_reply": true,
  "text": "Top related embedded sentence …",
  "author": "Alice",
  "score": 0.87,
  "thread_root_ts": "1712345600.000000",
  "in_thread": true,
  "thread": [
    {
      "id": 100,
      "user_id": "U999",
      "author": "Bob",
      "ts": "1712345600.000000",
      "text": "Root …"
    },
    {
      "id": 123,
      "user_id": "U123",
      "author": "Alice",
      "ts": "1712345678.000100",
      "text": "Hit …"
    }
  ]
}
```

Thread fetch (`\/api\/thread`):

```json
{
  "ok": true,
  "channel_id": "C123",
  "thread_root_ts": "1712345600.000000",
  "messages": [
    { "id": 100, "author": "Bob", "ts": "1712345600.000000", "text": "Root …" },
    {
      "id": 123,
      "author": "Alice",
      "ts": "1712345678.000100",
      "text": "Reply …"
    }
  ]
}
```

## Minimal FE pseudocode

```ts
type ThreadKey = string; // `${channel_id}:${thread_root_ts}`

const threadCache = new Map<
  ThreadKey,
  { messages: Message[]; lastFetchedAt: number }
>();

function keyFor(row: { channel_id: string; thread_root_ts: string }) {
  return `${row.channel_id}:${row.thread_root_ts}`;
}

async function ensureThread(row: any) {
  const key = keyFor(row);
  if (row.thread && row.thread.length) {
    threadCache.set(key, { messages: row.thread, lastFetchedAt: Date.now() });
    return row.thread;
  }
  const cached = threadCache.get(key);
  if (cached) return cached.messages;
  const res = await fetch(
    `/api/thread?channel_id=${row.channel_id}&root_ts=${row.thread_root_ts}`,
    { headers: authHeaders }
  );
  const data = await res.json();
  threadCache.set(key, { messages: data.messages, lastFetchedAt: Date.now() });
  return data.messages;
}
```

## Rollout notes

- Existing FE should remain compatible; new fields are additive.
- Favor `includeThreads: true` for search to provide immediate context; for large lists or mobile, consider lazy loading.
- Centralize thread caching in the FE to enable reuse across search and links views.
