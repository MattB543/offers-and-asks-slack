import { App, ExpressReceiver } from "@slack/bolt";
import express from "express";
import { config } from "dotenv";
import { db } from "./lib/database";
import { SEARCH_CONFIG } from "./config/searchConfig";
import { keywordSearchBridge } from "./services/keywordSearchBridge";
import { hybridSearchService } from "./services/hybridSearch";
import { cohereReranker } from "./services/cohereReranker";
import { embeddingService, channelSummarizerService } from "./lib/openai";
import { helperMatchingService, HelperSkill } from "./services/matching";
import { errorHandler } from "./utils/errorHandler";
import { sendWeeklyPrompts } from "./jobs/weekly-prompt";
import { UserService } from "./services/users";
import { oauthService } from "./services/oauth";
import { linkExtractionService } from "./services/linkExtractionService";
import { linkDatabaseService } from "./services/linkDatabaseService";
import { linkProcessingWorker } from "./workers/linkProcessingWorker";

config();

// Create receiver - use ExpressReceiver for OAuth support
let receiver: ExpressReceiver | undefined;

if (process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET) {
  receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    installationStore: {
      storeInstallation: async (installation) => {
        // This will be handled by our OAuth service
        return;
      },
      fetchInstallation: async (query) => {
        // This will be handled by our OAuth service
        throw new Error("Use OAuth service for installation management");
      },
    },
  });

  // Parse JSON bodies only for external endpoints to avoid interfering with Slack signature verification
  receiver.router.use("/external", express.json({ limit: "50mb" }));

  // Health endpoint
  receiver.router.get("/health", async (req, res) => {
    console.log("🏥 Health check endpoint hit");
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      message: "Server is running",
    });
  });

  // OAuth install endpoint
  receiver.router.get("/slack/install", async (req, res) => {
    try {
      const installUrl = oauthService.generateInstallUrl();
      res.redirect(installUrl);
    } catch (error) {
      console.error("❌ Failed to generate install URL:", error);
      res.status(500).send("Failed to generate install URL");
    }
  });

  // OAuth callback handler
  receiver.router.get("/slack/oauth_redirect", async (req, res) => {
    const code = req.query.code as string;
    const state = req.query.state as string;

    if (!code) {
      res.status(400).send("Authorization code missing");
      return;
    }

    try {
      const installation = await oauthService.handleCallback(code, state);

      res.status(200).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Installation Successful</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px; max-width: 600px; margin: 0 auto; }
              .success { color: #28a745; }
              .code { background: #f8f9fa; padding: 15px; border-radius: 8px; margin: 10px 0; font-family: monospace; }
              .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 8px; margin: 15px 0; }
            </style>
          </head>
          <body>
            <h1 class="success">✅ Installation Successful!</h1>
            <p>The <strong>Offers and Asks</strong> app has been successfully installed to <strong>${installation.team?.name}</strong>.</p>
            
            <div class="warning">
              <strong>🎉 You're all set!</strong> The app is now ready to use in your workspace.
              <br><br>
              Try messaging the bot directly or visiting the App Home to get started.
            </div>
            
            <p><small>You can now close this window.</small></p>
          </body>
        </html>
      `);
    } catch (error) {
      console.error("❌ OAuth callback failed:", error);
      res.status(500).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Installation Failed</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px; max-width: 600px; margin: 0 auto; }
              .error { color: #dc3545; }
            </style>
          </head>
          <body>
            <h1 class="error">❌ Installation Failed</h1>
            <p>There was an error installing the app. Please try again or contact support.</p>
            <p><small>Error: ${
              error instanceof Error ? error.message : "Unknown error"
            }</small></p>
          </body>
        </html>
      `);
    }
  });

  console.log("📱 OAuth endpoints enabled:");
  console.log("   Install: /slack/install");
  console.log("   Callback: /slack/oauth_redirect");

  // External endpoint to accept Slack-like message JSON with bearer token auth
  receiver.router.post("/external/slack-message", async (req, res) => {
    try {
      const configuredToken =
        process.env.EXTERNAL_POST_BEARER_TOKEN || process.env.BEARER_TOKEN;

      if (!configuredToken) {
        console.warn(
          "⚠️ EXTERNAL_POST_BEARER_TOKEN (or BEARER_TOKEN) not set; rejecting external message"
        );
        res.status(503).json({
          ok: false,
          error: "endpoint_not_configured",
          message:
            "Server missing EXTERNAL_POST_BEARER_TOKEN; ask the admin to set it.",
        });
        return;
      }

      const authorizationHeader = req.headers["authorization"] as
        | string
        | undefined;
      const presentedToken = authorizationHeader?.startsWith("Bearer ")
        ? authorizationHeader.substring("Bearer ".length)
        : undefined;

      if (!presentedToken || presentedToken !== configuredToken) {
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
      }

      if (!req.is("application/json")) {
        res.status(415).json({
          ok: false,
          error: "unsupported_media_type",
          message: 'Content-Type must be "application/json"',
        });
        return;
      }

      const payload = req.body as any;
      if (!payload || typeof payload !== "object") {
        res.status(400).json({ ok: false, error: "invalid_json" });
        return;
      }

      // Log a concise summary to avoid noisy logs
      console.log("📨 Received external Slack message payload", {
        hasText: typeof payload.text === "string",
        hasChannel: typeof payload.channel === "string",
        keys: Object.keys(payload).slice(0, 10),
      });

      // If the payload matches the SlackExport schema, persist to DB
      const isSlackExportShape =
        typeof payload.collection_time === "string" &&
        payload.channels &&
        typeof payload.channels === "object" &&
        !Array.isArray(payload.channels);

      let persistedExportId: number | undefined;
      let persistSummary:
        | {
            channelsProcessed: number;
            messagesInserted: number;
            repliesInserted: number;
            duplicatesSkipped: number;
            channelsWithMissingId: number;
          }
        | undefined;
      if (isSlackExportShape) {
        try {
          const { exportId, insertedMessages, summary } =
            await db.runInTransaction(async (client) => {
              // 1) Top-level export record
              const exportInsert = await client.query(
                `INSERT INTO slack_export (collection_time, raw) VALUES ($1, $2::jsonb) RETURNING id`,
                [payload.collection_time || null, JSON.stringify(payload)]
              );
              const exportId: number = exportInsert.rows[0].id;

              // 2) Channel metadata and 3) messages
              const channels: Record<string, any> = payload.channels;
              let channelsProcessed = 0;
              let messagesInserted = 0;
              let repliesInserted = 0;
              let duplicatesSkipped = 0;
              let channelsWithMissingId = 0;
              const insertedForEmbedding: Array<{
                id: number;
                text: string | null;
                subtype: string | null;
              }> = [];
              for (const [channelName, channelData] of Object.entries(
                channels
              )) {
                const channelId: string | null = channelData?.id || null;
                const messageCount: number | null =
                  channelData?.message_count ?? null;
                const threadRepliesCount: number | null =
                  channelData?.thread_replies_count ?? null;

                const channelInsert = await client.query(
                  `INSERT INTO slack_channel_export (export_id, channel_id, channel_name, message_count, thread_replies_count)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (export_id, channel_id) DO UPDATE SET
                   channel_name = EXCLUDED.channel_name,
                   message_count = EXCLUDED.message_count,
                   thread_replies_count = EXCLUDED.thread_replies_count
                 RETURNING id`,
                  [
                    exportId,
                    channelId,
                    channelName,
                    messageCount,
                    threadRepliesCount,
                  ]
                );
                const channelExportId: number = channelInsert.rows[0].id;
                channelsProcessed += 1;

                const messages: any[] = Array.isArray(channelData?.messages)
                  ? channelData.messages
                  : [];

                if (!channelId) {
                  channelsWithMissingId += 1;
                  if (messages.length > 0) {
                    console.warn(
                      `⚠️ Skipping message inserts for channel "${channelName}" because channel_id is missing`
                    );
                  }
                }

                // Cache resolved display names to minimize DB lookups within this transaction
                const displayNameCache = new Map<string, string>();
                const resolveDisplayName = async (
                  slackUserId: string | null
                ): Promise<string | null> => {
                  if (!slackUserId) return null;
                  if (displayNameCache.has(slackUserId)) {
                    return displayNameCache.get(slackUserId)!;
                  }
                  const res = await client.query(
                    `SELECT display_name FROM people WHERE slack_user_id = $1 LIMIT 1`,
                    [slackUserId]
                  );
                  const dn =
                    (res.rows?.[0]?.display_name as string | undefined) || null;
                  if (dn) displayNameCache.set(slackUserId, dn);
                  return dn;
                };

                const insertMessage = async (
                  msg: any,
                  isReply: boolean,
                  parentTs: string | null
                ) => {
                  const ts: string = String(
                    (msg && (msg.timestamp ?? msg.ts)) as any
                  );
                  const userId: string | null =
                    (msg && (msg.user_id ?? msg.user)) ?? null;
                  // Prefer canonical display_name from our people table; fallback to raw user_name
                  const userNameFromDb = await resolveDisplayName(userId);
                  const userName: string | null =
                    userNameFromDb ?? msg?.user_name ?? null;
                  const text: string | null = msg.text ?? null;
                  const messageType: string | null = msg.type ?? null;
                  const subtype: string | null = msg.subtype ?? null;
                  const threadTs: string | null = msg.thread_ts ?? null;
                  if (!channelId) {
                    return false;
                  }
                  const result = await client.query(
                    `INSERT INTO slack_message (
                    export_id,
                    channel_export_id,
                    channel_id,
                    channel_name,
                    ts,
                    user_id,
                      user_name,
                    text,
                    message_type,
                    subtype,
                    thread_ts,
                    is_reply,
                    parent_ts,
                    raw
                  ) VALUES (
                      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb
                  ) ON CONFLICT (channel_id, ts) DO NOTHING RETURNING id, text, subtype`,
                    [
                      exportId,
                      channelExportId,
                      channelId,
                      channelName,
                      ts,
                      userId,
                      userName,
                      text,
                      messageType,
                      subtype,
                      threadTs,
                      isReply,
                      parentTs,
                      JSON.stringify(msg),
                    ]
                  );
                  const inserted = result.rowCount === 1;
                  if (inserted) {
                    const row = result.rows[0] as {
                      id: number;
                      text: string | null;
                      subtype: string | null;
                    };
                    // Only embed meaningful texts and exclude channel join
                    if (
                      row &&
                      row.text &&
                      (row.subtype ?? "") !== "channel_join"
                    ) {
                      insertedForEmbedding.push(row);
                    }
                  }
                  return inserted;
                };

                for (const msg of messages) {
                  const inserted = await insertMessage(msg, false, null);
                  if (inserted) {
                    messagesInserted += 1;
                  } else {
                    duplicatesSkipped += 1; // either duplicate or missing channel id
                  }
                  const replies: any[] = Array.isArray(msg.replies)
                    ? msg.replies
                    : [];
                  for (const reply of replies) {
                    const rInserted = await insertMessage(
                      reply,
                      true,
                      String((msg && (msg.timestamp ?? msg.ts)) as any)
                    );
                    if (rInserted) {
                      repliesInserted += 1;
                    } else {
                      duplicatesSkipped += 1;
                    }
                  }
                }
              }

              const persistSummary = {
                channelsProcessed,
                messagesInserted,
                repliesInserted,
                duplicatesSkipped,
                channelsWithMissingId,
              };
              return {
                exportId,
                insertedMessages: insertedForEmbedding,
                summary: persistSummary,
              };
            });
          persistedExportId = exportId;
          persistSummary = summary;

          // Post-commit: embed newly inserted messages in batches
          try {
            const toEmbed = (insertedMessages || [])
              .map((m) => ({
                id: m.id,
                text: (m.text || "").trim(),
                subtype: m.subtype,
              }))
              .filter(
                (m) => m.text.length > 0 && (m.subtype ?? "") !== "channel_join"
              );
            const batchSize = 200;
            for (let i = 0; i < toEmbed.length; i += batchSize) {
              const batch = toEmbed.slice(i, i + batchSize);
              const vectors = await embeddingService.generateMultipleEmbeddings(
                batch.map((b) => b.text)
              );
              const pairs = batch.map((b, idx) => ({
                id: b.id,
                embedding: vectors[idx] || [],
              }));
              await db.batchUpdateSlackMessageEmbeddings(pairs);
              await new Promise((r) => setTimeout(r, 200));
            }
          } catch (e) {
            console.warn(
              "⚠️ Auto-embed of ingested messages failed (continuing):",
              e
            );
          }

          // Post-commit: extract links from newly inserted messages
          try {
            console.log(`🔗 Extracting links from ${(insertedMessages || []).length} messages...`);
            let totalLinksExtracted = 0;
            
            for (const message of insertedMessages || []) {
              if (message.text && message.text.trim().length > 0) {
                // Look up the full message data to get channel name and user
                const messageDetails = await db.query(
                  'SELECT channel_name, user_name FROM slack_message WHERE id = $1',
                  [message.id]
                );
                
                if (messageDetails.rows.length > 0) {
                  const { channel_name, user_name } = messageDetails.rows[0];
                  const linksFound = await linkExtractionService.processMessageLinks(
                    message.id.toString(),
                    message.text,
                    channel_name || 'unknown',
                    user_name || 'unknown'
                  );
                  totalLinksExtracted += linksFound;
                }
              }
            }
            
            if (totalLinksExtracted > 0) {
              console.log(`✅ Extracted ${totalLinksExtracted} links from messages`);
            }
          } catch (e) {
            console.warn(
              "⚠️ Link extraction from ingested messages failed (continuing):",
              e
            );
          }
        } catch (dbError) {
          console.error("❌ Failed to persist SlackExport:", dbError);
          await errorHandler.handle(dbError, "persist_slack_export");
          res.status(500).json({ ok: false, error: "db_persist_failed" });
          return;
        }
      }

      // Optionally forward to Slack if channel + text (or blocks) are provided
      const channel: string | undefined = payload.channel;
      const text: string | undefined = payload.text;
      const blocks: any[] | undefined = payload.blocks;
      const threadTs: string | undefined =
        payload.thread_ts || payload.threadTs;

      let posted = false;
      let postResponse: any = undefined;

      if (channel && (text || blocks)) {
        // Resolve bot token: prefer team from payload/header, fallback to env
        const teamId: string | undefined =
          payload.teamId ||
          payload.team_id ||
          payload.team?.id ||
          (req.headers["x-slack-team-id"] as string | undefined);

        let botToken: string | null | undefined = undefined;
        if (teamId) {
          try {
            botToken = await oauthService.getBotToken(teamId);
          } catch (e) {
            console.warn("⚠️ Failed to fetch bot token for team:", teamId, e);
          }
        }
        if (!botToken) {
          botToken = process.env.SLACK_BOT_TOKEN || null;
        }

        if (!botToken) {
          res.status(503).json({
            ok: false,
            error: "no_bot_token_available",
            message:
              "No bot token available. Provide teamId for an installed workspace or set SLACK_BOT_TOKEN.",
          });
          return;
        }

        try {
          postResponse = await app.client.chat.postMessage({
            token: botToken,
            channel,
            text: text || undefined,
            blocks: (blocks as any) || undefined,
            thread_ts: threadTs || undefined,
          });
          posted = Boolean(postResponse?.ok);
        } catch (e) {
          console.error("❌ chat.postMessage failed:", e);
          res.status(502).json({ ok: false, error: "slack_post_failed" });
          return;
        }
      }

      res.status(200).json({
        ok: true,
        status: "accepted",
        posted,
        slack: postResponse,
        export_id: persistedExportId,
        persist: persistSummary,
      });
    } catch (err) {
      console.error("❌ External slack-message handler failed:", err);
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });
  console.log(
    "🔐 External endpoint enabled: POST /external/slack-message (Bearer auth)"
  );

  // Lightweight CORS for /api routes (optional)
  if (process.env.CORS_ALLOW_ORIGIN || process.env.ENABLE_CORS === "true") {
    const normalizeOrigin = (o: string) => o.replace(/\/$/, "");
    const rawAllowed = (process.env.CORS_ALLOW_ORIGIN || "*")
      .split(",")
      .map((s) => normalizeOrigin(s.trim()))
      .filter((s) => s.length > 0);

    receiver.router.use("/api", (req, res, next) => {
      const requestOrigin = normalizeOrigin(
        ((req.headers["origin"] as string | undefined) || "").trim()
      );
      let originToAllow: string | undefined = undefined;

      if (rawAllowed.length === 0 || rawAllowed.includes("*")) {
        originToAllow = "*";
      } else if (requestOrigin && rawAllowed.includes(requestOrigin)) {
        originToAllow = requestOrigin;
        res.header("Vary", "Origin");
      }

      if (originToAllow) {
        res.header("Access-Control-Allow-Origin", originToAllow);
      }
      res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization"
      );
      res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    });
  }

  // Hybrid search API (semantic + keyword, optional rerank, optional thread context)
  receiver.router.post("/api/search", express.json(), async (req, res) => {
    const requestId = Math.random().toString(36).substring(2, 8);
    const startTime = Date.now();
    
    console.log(`\n🔍 [${requestId}] === SEARCH API REQUEST START ===`);
    console.log(`🔍 [${requestId}] Request timestamp: ${new Date().toISOString()}`);
    console.log(`🔍 [${requestId}] Request origin: ${req.headers.origin || 'none'}`);
    console.log(`🔍 [${requestId}] User-Agent: ${req.headers['user-agent']?.substring(0, 100) || 'none'}`);
    
    try {
      console.log(`🔐 [${requestId}] Checking authentication...`);
      const configuredToken =
        process.env.EXTERNAL_POST_BEARER_TOKEN || process.env.BEARER_TOKEN;
      if (configuredToken) {
        const authorizationHeader = req.headers["authorization"] as
          | string
          | undefined;
        const presentedToken = authorizationHeader?.startsWith("Bearer ")
          ? authorizationHeader.substring("Bearer ".length)
          : undefined;
        if (!presentedToken || presentedToken !== configuredToken) {
          console.log(`❌ [${requestId}] Authentication failed - invalid token`);
          res.status(401).json({ ok: false, error: "unauthorized" });
          return;
        }
        console.log(`✅ [${requestId}] Authentication successful`);
      } else {
        console.log(`⚠️ [${requestId}] No authentication required (no token configured)`);
      }
      console.log(`📋 [${requestId}] Parsing request body...`);
      const {
        query,
        topK,
        channels,
        dateFrom,
        dateTo,
        includeThreads,
        useReranking,
        sources,
        useAdvancedRetrieval,
        enableRecencyBoost,
        enableContextExpansion,
        includeDocumentSummaries,
      } = req.body || {};
      
      console.log(`📋 [${requestId}] Request parameters:`, {
        query: query ? `"${query.substring(0, 100)}${query.length > 100 ? '...' : ''}"` : 'undefined',
        topK: topK || 'default',
        channels: channels?.length ? `${channels.length} channels` : 'all channels',
        dateFrom,
        dateTo,
        includeThreads,
        useReranking,
        sources: sources || ['slack', 'document'],
        useAdvancedRetrieval: useAdvancedRetrieval ?? false,
        enableRecencyBoost: enableRecencyBoost ?? true,
        enableContextExpansion: enableContextExpansion ?? true,
        includeDocumentSummaries: includeDocumentSummaries ?? true,
      });
      
      if (!query || typeof query !== "string") {
        console.log(`❌ [${requestId}] Invalid query parameter`);
        res.status(400).json({ ok: false, error: "query_required" });
        return;
      }
      // Check if we should use the new unified search service
      if (useAdvancedRetrieval || sources) {
        console.log(`🚀 [${requestId}] Using advanced unified search service...`);
        
        // Import the unified search service
        const { unifiedSearchService } = await import('./services/unifiedSearch');
        
        const searchOptions = {
          sources: sources || ['slack', 'document'],
          limit: Number(topK) || 20,
          includeDocumentSummaries: includeDocumentSummaries ?? true,
          rerank: useReranking ?? true,
          useAdvancedRetrieval: useAdvancedRetrieval ?? false,
          enableContextExpansion: enableContextExpansion ?? true,
          enableRecencyBoost: enableRecencyBoost ?? true,
        };
        
        console.log(`🔧 [${requestId}] Search options:`, searchOptions);
        
        const searchResults = await unifiedSearchService.search(query, searchOptions);
        
        console.log(`✅ [${requestId}] Unified search completed - ${searchResults.length} results`);
        console.log(`📊 [${requestId}] Results by source:`, searchResults.reduce((acc, r) => {
          acc[r.source] = (acc[r.source] || 0) + 1;
          return acc;
        }, {} as Record<string, number>));
        
        const duration = Date.now() - startTime;
        console.log(`⏱️ [${requestId}] Total request duration: ${duration}ms`);
        console.log(`🔍 [${requestId}] === SEARCH API REQUEST END ===\n`);
        
        res.json({ 
          ok: true, 
          results: searchResults,
          meta: {
            total: searchResults.length,
            duration_ms: duration,
            search_type: 'unified_advanced',
            request_id: requestId
          }
        });
        return;
      }
      
      console.log(`🔄 [${requestId}] Using legacy search implementation...`);
      console.log(`🧠 [${requestId}] Generating embeddings for query...`);
      const qEmbedding = await embeddingService.generateEmbedding(query);
      console.log(`✅ [${requestId}] Embeddings generated (${qEmbedding.length} dimensions)`);
      
      console.log(`🗄️ [${requestId}] Executing semantic similarity query...`);
      const result = await db.query(
        `SELECT m.id,
                m.channel_id,
                m.channel_name,
                m.user_id,
                m.ts,
                m.thread_ts,
                m.parent_ts,
                m.is_reply,
                LEFT(m.text, 300) AS text,
                 COALESCE(p.display_name, m.user_id) AS author,
                1 - (m.embedding <=> $1::vector) AS score
         FROM slack_message m
          LEFT JOIN LATERAL (
            SELECT display_name
            FROM people
            WHERE slack_user_id = m.user_id
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1
          ) p ON true
         WHERE m.embedding IS NOT NULL
            AND COALESCE(m.subtype,'') NOT IN (
              'channel_join','channel_leave','bot_message','message_changed','message_deleted',
              'thread_broadcast','file_share','channel_topic','channel_purpose','channel_name',
              'channel_archive','channel_unarchive','group_join','group_leave'
            )
           AND ($2::text[] IS NULL OR m.channel_id = ANY($2))
           AND ($3::timestamptz IS NULL OR m.created_at >= $3)
           AND ($4::timestamptz IS NULL OR m.created_at <= $4)
         ORDER BY m.embedding <=> $1::vector ASC
         LIMIT LEAST(COALESCE($5, 100), 100)`,
        [
          `[${qEmbedding.join(",")}]`,
          Array.isArray(channels) && channels.length ? channels : null,
          dateFrom || null,
          dateTo || null,
          Math.max(Number(topK) || 20, SEARCH_CONFIG.hybrid.initialCandidates),
        ]
      );

      const semanticRows = result.rows as Array<any>;
      console.log(`📊 [${requestId}] Semantic query returned ${semanticRows.length} results`);

      // Prepare semantic list as [docId, score] where docId is `${channel_id}:${r.ts}`
      const semanticList: Array<[string, number]> = semanticRows.map((r) => [
        `${r.channel_id}:${r.ts}`,
        Number(r.score) || 0,
      ]);
      console.log(`🔄 [${requestId}] Prepared semantic list: ${semanticList.length} items`);

      // Keyword results via BM25 (Python bridge)
      console.log(`🔤 [${requestId}] Executing BM25 keyword search...`);
      const keywordList = await keywordSearchBridge.search(
        query,
        SEARCH_CONFIG.bm25.topK
      );
      console.log(`📊 [${requestId}] BM25 search returned ${keywordList.length} results`);

      // Combine via RRF
      console.log(`🔀 [${requestId}] Combining results with Reciprocal Rank Fusion...`);
      const combined = hybridSearchService.reciprocalRankFusion(
        semanticList,
        keywordList,
        {
          k: SEARCH_CONFIG.hybrid.rrfK,
          semanticWeight: SEARCH_CONFIG.hybrid.semanticWeight,
        }
      );
      console.log(`📊 [${requestId}] RRF combined ${combined.length} unique results`);
      console.log(`🔧 [${requestId}] RRF config: k=${SEARCH_CONFIG.hybrid.rrfK}, semanticWeight=${SEARCH_CONFIG.hybrid.semanticWeight}`);
      

      const finalTopK = Math.min(Number(topK) || 100, 100);
      const topCombined = combined.slice(0, Math.max(finalTopK, 20));

      // Fetch full rows for the combined ids
      const idsByChannel = new Map<string, Set<string>>();
      for (const [docId] of topCombined) {
        const [cid, ts] = docId.split(":");
        if (!cid || !ts) continue;
        if (!idsByChannel.has(cid)) idsByChannel.set(cid, new Set());
        idsByChannel.get(cid)!.add(ts);
      }

      const fetchedMap = new Map<string, any>();
      for (const [cid, tsSet] of idsByChannel.entries()) {
        const tsArray = Array.from(tsSet);
        const fetched = await db.query(
          `SELECT m.id,
                  m.channel_id,
                  m.channel_name,
                  m.user_id,
                  m.ts,
                  m.thread_ts,
                  m.parent_ts,
                  m.is_reply,
                  LEFT(m.text, 300) AS text,
                  COALESCE(p.display_name, m.user_id) AS author
           FROM slack_message m
           LEFT JOIN LATERAL (
             SELECT display_name
             FROM people
             WHERE slack_user_id = m.user_id
             ORDER BY updated_at DESC NULLS LAST
             LIMIT 1
           ) p ON true
           WHERE m.channel_id = $1 AND m.ts = ANY($2::text[])`,
          [cid, tsArray]
        );
        for (const r of fetched.rows as any[]) {
          fetchedMap.set(`${r.channel_id}:${r.ts}`, r);
        }
      }

      // Order final results by combined score
      let ordered = topCombined
        .map(([docId, score]) => ({ row: fetchedMap.get(docId), score }))
        .filter((x) => x.row);

      // Optional reranking with cross-encoder
      const shouldRerank =
        (useReranking ?? SEARCH_CONFIG.reranker.enabledByDefault) === true;
      if (shouldRerank && ordered.length > 0) {
        try {
          const reranked = await cohereReranker.rerankSlackMessages(
            query,
            ordered.map((x) => x.row),
            finalTopK
          );
          // Only use reranked if we got valid results
          if (reranked && reranked.length > 0) {
            ordered = reranked.map(({ index, score }) => ({
              row: ordered[index].row,
              score: score,
            }));
          }
        } catch (e) {
          console.error("Reranking failed, using hybrid results:", e);
          // Continue with hybrid results if reranking fails
        }
      }

      const rows = ordered.map((o) => o.row).slice(0, finalTopK);

      // Include thread context if requested
      const shouldIncludeThreads = includeThreads !== false;
      if (!shouldIncludeThreads) {
        const mapped = rows.map((r) => ({
          ...r,
          thread_root_ts: r.thread_ts || r.parent_ts || r.ts,
          in_thread: Boolean(r.thread_ts || r.parent_ts),
        }));
        res.json({ ok: true, results: mapped });
        return;
      }

      const threadCache = new Map<string, any[]>();
      const enhanceWithThread = async (row: any): Promise<any> => {
        const rootTs: string = row.thread_ts || row.parent_ts || row.ts;
        const key = `${row.channel_id}:${rootTs}`;
        if (!threadCache.has(key)) {
          const threadRes = await db.query(
            `SELECT m.id,
                    m.channel_id,
                    m.channel_name,
                    m.user_id,
                    m.ts,
                    LEFT(m.text, 1000) AS text,
                     COALESCE(p.display_name, m.user_id) AS author
             FROM slack_message m
              LEFT JOIN LATERAL (
                SELECT display_name
                FROM people
                WHERE slack_user_id = m.user_id
                ORDER BY updated_at DESC NULLS LAST
                LIMIT 1
              ) p ON true
             WHERE m.channel_id = $1
               AND m.text IS NOT NULL
                AND COALESCE(m.subtype,'') NOT IN (
                  'channel_join','channel_leave','bot_message','message_changed','message_deleted',
                  'thread_broadcast','file_share','channel_topic','channel_purpose','channel_name',
                  'channel_archive','channel_unarchive','group_join','group_leave'
                )
               AND (m.ts = $2 OR m.parent_ts = $2 OR m.thread_ts = $2)
             ORDER BY m.ts ASC, m.id ASC`,
            [row.channel_id, rootTs]
          );
          threadCache.set(key, threadRes.rows);
        }
        return {
          ...row,
          thread_root_ts: rootTs,
          in_thread: Boolean(row.thread_ts || row.parent_ts),
          thread: threadCache.get(key),
        };
      };

      const enhanced = await Promise.all(rows.map(enhanceWithThread));
      res.json({ ok: true, results: enhanced });
    } catch (e) {
      console.error("/api/search failed:", e);
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });

  // Unified Summary API for both Slack messages and document chunks
  receiver.router.post("/api/summarize", express.json(), async (req, res) => {
    try {
      const configuredToken =
        process.env.EXTERNAL_POST_BEARER_TOKEN || process.env.BEARER_TOKEN;
      if (configuredToken) {
        const authorizationHeader = req.headers["authorization"] as
          | string
          | undefined;
        const presentedToken = authorizationHeader?.startsWith("Bearer ")
          ? authorizationHeader.substring("Bearer ".length)
          : undefined;
        if (!presentedToken || presentedToken !== configuredToken) {
          res.status(401).json({ ok: false, error: "unauthorized" });
          return;
        }
      }
      
      // Accept both legacy messageIds and new resultIds format
      const { messageIds, resultIds, searchQuery } = req.body || {};
      const inputIds = resultIds || messageIds;
      
      if (!Array.isArray(inputIds) || inputIds.length === 0) {
        res.status(400).json({ ok: false, error: "resultIds_or_messageIds_required" });
        return;
      }
      
      // Separate Slack and document IDs
      const slackIds: number[] = [];
      const documentIds: string[] = [];
      
      for (const id of inputIds.slice(0, 100)) {
        if (typeof id === 'string') {
          if (id.startsWith('slack_')) {
            const numId = Number(id.replace('slack_', ''));
            if (Number.isFinite(numId)) slackIds.push(numId);
          } else if (id.startsWith('doc_')) {
            documentIds.push(id);
          }
        } else if (typeof id === 'number' && Number.isFinite(id)) {
          // Legacy support for numeric message IDs
          slackIds.push(id);
        }
      }
      
      if (slackIds.length === 0 && documentIds.length === 0) {
        res.status(400).json({ ok: false, error: "no_valid_ids" });
        return;
      }
      // Prepare content arrays
      const threads: Array<{
        channel_id: string;
        channel_name: string | null;
        thread_root_ts: string;
        messages: Array<{
          id: number;
          channel_id: string;
          channel_name: string | null;
          user_id: string;
          author: string;
          ts: string;
          text: string;
        }>;
      }> = [];
      
      const documents: Array<{
        document_id: string;
        title: string;
        file_path: string;
        chunks: Array<{
          id: string;
          content: string;
          section_title: string | null;
          hierarchy_level: number;
          order: number;
        }>;
      }> = [];
      
      // Process Slack messages if any
      if (slackIds.length > 0) {
        const baseRowsRes = await db.query(
          `SELECT m.id,
                  m.channel_id,
                  m.channel_name,
                  m.ts,
                  m.thread_ts,
                  m.parent_ts
           FROM slack_message m
           WHERE m.id = ANY($1::bigint[])`,
          [slackIds]
        );

        const baseRows: Array<{
          id: number;
          channel_id: string;
          channel_name: string | null;
          ts: string;
          thread_ts: string | null;
          parent_ts: string | null;
        }> = baseRowsRes.rows as any;

        // Determine unique threads to include (full context for each selected message)
        const threadKeys = new Map<
          string,
          { channel_id: string; root_ts: string; channel_name: string | null }
        >();
        for (const r of baseRows) {
          const rootTs = (r.thread_ts || r.parent_ts || r.ts) as string;
          const key = `${r.channel_id}:${rootTs}`;
          if (!threadKeys.has(key)) {
            threadKeys.set(key, {
              channel_id: r.channel_id,
              root_ts: rootTs,
              channel_name: r.channel_name,
            });
          }
        }

        // Fetch full thread messages for each unique thread
        for (const tk of threadKeys.values()) {
          const threadRes = await db.query(
            `SELECT m.id,
                    m.channel_id,
                    m.channel_name,
                    m.user_id,
                    m.ts,
                    LEFT(m.text, 4000) AS text,
                    COALESCE(p.display_name, m.user_id) AS author
             FROM slack_message m
              LEFT JOIN LATERAL (
                SELECT display_name
                FROM people
                WHERE slack_user_id = m.user_id
                ORDER BY updated_at DESC NULLS LAST
                LIMIT 1
              ) p ON true
             WHERE m.channel_id = $1
               AND m.text IS NOT NULL
               AND m.user_id != 'U09934RTP4J'
               AND COALESCE(m.subtype,'') NOT IN (
                 'channel_join','channel_leave','bot_message','message_changed','message_deleted',
                 'thread_broadcast','file_share','channel_topic','channel_purpose','channel_name',
                 'channel_archive','channel_unarchive','group_join','group_leave'
               )
               AND (m.ts = $2 OR m.parent_ts = $2 OR m.thread_ts = $2)
             ORDER BY m.ts ASC, m.id ASC`,
            [tk.channel_id, tk.root_ts]
          );

          threads.push({
            channel_id: tk.channel_id,
            channel_name: tk.channel_name,
            thread_root_ts: tk.root_ts,
            messages: (threadRes.rows as any[]).map((m) => ({
              id: m.id,
              channel_id: m.channel_id,
              channel_name: m.channel_name,
              user_id: m.user_id,
              author: m.author,
              ts: m.ts,
              text: m.text,
            })),
          });
        }
      }
      
      // Process documents if any
      if (documentIds.length > 0) {
        // Parse document IDs to determine what content to fetch
        const docChunkIds: string[] = [];
        const fullDocIds: string[] = [];
        
        for (const id of documentIds) {
          if (id.startsWith('doc_chunk_')) {
            docChunkIds.push(id.replace('doc_chunk_', ''));
          } else if (id.startsWith('doc_')) {
            fullDocIds.push(id.replace('doc_', ''));
          }
        }
        
        // Handle individual chunks (with context expansion for large doc)
        if (docChunkIds.length > 0) {
          const chunkRes = await db.query(`
            SELECT 
              de.id,
              de.content,
              de.section_title,
              de.hierarchy_level,
              de.document_id,
              d.id as doc_id,
              d.title as document_title,
              d.file_path,
              d.document_id as external_doc_id
            FROM document_embeddings de
            JOIN documents d ON de.document_id = d.id
            WHERE de.id = ANY($1::int[])
          `, [docChunkIds.map(id => parseInt(id))]);
          
          // Group chunks by document
          const docGroups = new Map<string, any[]>();
          for (const chunk of chunkRes.rows) {
            const key = chunk.doc_id;
            if (!docGroups.has(key)) {
              docGroups.set(key, []);
            }
            docGroups.get(key)!.push(chunk);
          }
          
          // For each document, fetch appropriate context
          for (const [docId, chunks] of docGroups) {
            const firstChunk = chunks[0];
            const isLargeDoc = firstChunk.external_doc_id === 'ed6fe52043cf6e7c';
            
            if (isLargeDoc) {
              // For large doc, get 10 chunks on either side of each relevant chunk
              for (const chunk of chunks) {
                const contextRes = await db.query(`
                  SELECT 
                    de.id,
                    de.content,
                    de.section_title,
                    de.hierarchy_level,
                    de.chunk_index
                  FROM document_embeddings de
                  WHERE de.document_id = $1
                    AND de.chunk_index BETWEEN $2 AND $3
                  ORDER BY de.chunk_index
                `, [docId, Math.max(0, chunk.chunk_index - 10), chunk.chunk_index + 10]);
                
                documents.push({
                  document_id: `doc_${docId}`,
                  title: firstChunk.document_title,
                  file_path: firstChunk.file_path,
                  chunks: contextRes.rows.map((c: any, idx: number) => ({
                    id: `chunk_${c.id}`,
                    content: c.content,
                    section_title: c.section_title,
                    hierarchy_level: c.hierarchy_level,
                    order: idx + 1
                  }))
                });
              }
            } else {
              // For normal docs, get all chunks
              const allChunksRes = await db.query(`
                SELECT 
                  de.id,
                  de.content,
                  de.section_title,
                  de.hierarchy_level,
                  de.chunk_index
                FROM document_embeddings de
                WHERE de.document_id = $1
                ORDER BY de.chunk_index
              `, [docId]);
              
              documents.push({
                document_id: `doc_${docId}`,
                title: firstChunk.document_title,
                file_path: firstChunk.file_path,
                chunks: allChunksRes.rows.map((c: any, idx: number) => ({
                  id: `chunk_${c.id}`,
                  content: c.content,
                  section_title: c.section_title,
                  hierarchy_level: c.hierarchy_level,
                  order: idx + 1
                }))
              });
            }
          }
        }
        
        // Handle full document IDs
        if (fullDocIds.length > 0) {
          for (const docId of fullDocIds) {
            // Check if this is the large document
            const docInfoRes = await db.query(`
              SELECT document_id, title, file_path
              FROM documents
              WHERE id = $1
            `, [parseInt(docId)]);
            
            if (docInfoRes.rows.length > 0) {
              const docInfo = docInfoRes.rows[0];
              const isLargeDoc = docInfo.document_id === 'ed6fe52043cf6e7c';
              
              if (isLargeDoc) {
                // For large doc, just get first 30 chunks as sample
                const chunksRes = await db.query(`
                  SELECT 
                    de.id,
                    de.content,
                    de.section_title,
                    de.hierarchy_level,
                    de.chunk_index
                  FROM document_embeddings de
                  WHERE de.document_id = $1
                  ORDER BY de.chunk_index
                  LIMIT 30
                `, [parseInt(docId)]);
                
                documents.push({
                  document_id: `doc_${docId}`,
                  title: docInfo.title + ' (excerpt)',
                  file_path: docInfo.file_path,
                  chunks: chunksRes.rows.map((c: any, idx: number) => ({
                    id: `chunk_${c.id}`,
                    content: c.content,
                    section_title: c.section_title,
                    hierarchy_level: c.hierarchy_level,
                    order: idx + 1
                  }))
                });
              } else {
                // Get all chunks for normal documents
                const chunksRes = await db.query(`
                  SELECT 
                    de.id,
                    de.content,
                    de.section_title,
                    de.hierarchy_level,
                    de.chunk_index
                  FROM document_embeddings de
                  WHERE de.document_id = $1
                  ORDER BY de.chunk_index
                `, [parseInt(docId)]);
                
                documents.push({
                  document_id: `doc_${docId}`,
                  title: docInfo.title,
                  file_path: docInfo.file_path,
                  chunks: chunksRes.rows.map((c: any, idx: number) => ({
                    id: `chunk_${c.id}`,
                    content: c.content,
                    section_title: c.section_title,
                    hierarchy_level: c.hierarchy_level,
                    order: idx + 1
                  }))
                });
              }
            }
          }
        }
      }

      // Call unified summarizer for both Slack and documents
      const summary = await channelSummarizerService.summarizeUnifiedContent(
        {
          searchQuery: typeof searchQuery === "string" ? searchQuery : null,
          threads,
          documents
        }
      );

      res.json({ ok: true, summary, threads, documents });
    } catch (e) {
      console.error("/api/summarize failed:", e);
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });

  // Extended Search API - combines search with context expansion
  receiver.router.post("/api/extended-search", express.json(), async (req, res) => {
    const requestId = Math.random().toString(36).substring(2, 8);
    const startTime = Date.now();
    
    try {
      // Authentication check
      const configuredToken = process.env.EXTERNAL_POST_BEARER_TOKEN || process.env.BEARER_TOKEN;
      if (configuredToken) {
        const authorizationHeader = req.headers["authorization"] as string | undefined;
        const presentedToken = authorizationHeader?.startsWith("Bearer ") 
          ? authorizationHeader.substring("Bearer ".length) 
          : undefined;
        if (!presentedToken || presentedToken !== configuredToken) {
          res.status(401).json({ ok: false, error: "unauthorized" });
          return;
        }
      }

      const { query, sources = ['slack', 'document'] } = req.body || {};
      
      if (!query || typeof query !== "string") {
        res.status(400).json({ ok: false, error: "query_required" });
        return;
      }

      console.log(`🚀 [${requestId}] Extended search for: "${query}"`);

      // Get top 100 results using unified search
      const { unifiedSearchService } = await import('./services/unifiedSearch');
      const searchResults = await unifiedSearchService.search(query, {
        sources,
        limit: 100,
        includeDocumentSummaries: false,
        rerank: true,
        useAdvancedRetrieval: true,
        enableContextExpansion: false,
        enableRecencyBoost: true,
      });

      // Separate results by source
      const slackResults = searchResults.filter(r => r.source === 'slack');
      const documentResults = searchResults.filter(r => r.source === 'document');
      
      console.log(`📊 [${requestId}] ${slackResults.length} Slack, ${documentResults.length} docs`);

      // Expand Slack context
      const expandedSlackContext = [];
      for (const slackResult of slackResults) {
        const messageId = parseInt(slackResult.id.replace('slack_', ''));
        
        // Get original message
        const messageRes = await db.query(
          `SELECT id, channel_id, channel_name, ts, thread_ts, parent_ts, text, user_id
           FROM slack_message WHERE id = $1`, [messageId]);
        
        if (messageRes.rows.length === 0) continue;
        const msg = messageRes.rows[0];
        
        // Get thread context
        const threadRootTs = msg.thread_ts || msg.parent_ts || msg.ts;
        const threadRes = await db.query(
          `SELECT id, user_id, ts, text FROM slack_message 
           WHERE channel_id = $1 AND (ts = $2 OR parent_ts = $2 OR thread_ts = $2)
           AND text IS NOT NULL ORDER BY ts ASC`,
          [msg.channel_id, threadRootTs]);

        // Get surrounding messages (5 before, 5 after)
        const surroundingRes = await db.query(
          `(SELECT id, user_id, ts, text, 'before' as position FROM slack_message 
            WHERE channel_id = $1 AND ts < $2 AND text IS NOT NULL 
            ORDER BY ts DESC LIMIT 5)
           UNION ALL
           (SELECT id, user_id, ts, text, 'after' as position FROM slack_message 
            WHERE channel_id = $1 AND ts > $2 AND text IS NOT NULL 
            ORDER BY ts ASC LIMIT 5)
           ORDER BY ts ASC`,
          [msg.channel_id, msg.ts]);

        expandedSlackContext.push({
          original_match: slackResult,
          thread_context: threadRes.rows,
          surrounding_context: surroundingRes.rows,
          channel_info: { channel_id: msg.channel_id, channel_name: msg.channel_name }
        });
      }

      // Expand document context
      const expandedDocumentContext = [];
      for (const docResult of documentResults) {
        const chunkId = parseInt(docResult.id.replace('doc_chunk_', ''));
        
        // Get chunk and document info
        const chunkRes = await db.query(
          `SELECT de.id, de.content, de.section_title, de.chunk_index, de.document_id, 
                  d.title, d.file_path
           FROM document_embeddings de JOIN documents d ON de.document_id = d.id
           WHERE de.id = $1`, [chunkId]);
        
        if (chunkRes.rows.length === 0) continue;
        const chunk = chunkRes.rows[0];
        
        // Get 3 chunks on either side
        const expandedChunksRes = await db.query(
          `SELECT id, content, section_title, chunk_index
           FROM document_embeddings 
           WHERE document_id = $1 AND chunk_index BETWEEN $2 AND $3
           ORDER BY chunk_index`,
          [chunk.document_id, Math.max(0, chunk.chunk_index - 3), chunk.chunk_index + 3]);

        expandedDocumentContext.push({
          original_match: docResult,
          document_info: { title: chunk.title, file_path: chunk.file_path },
          expanded_chunks: expandedChunksRes.rows.map((c: any, idx: number) => ({
            ...c,
            is_original_match: c.id === chunkId,
            order: idx + 1
          }))
        });
      }

      const duration = Date.now() - startTime;
      console.log(`✅ [${requestId}] Extended search completed in ${duration}ms`);

      res.json({
        ok: true,
        query,
        total_results: searchResults.length,
        slack_contexts: expandedSlackContext,
        document_contexts: expandedDocumentContext,
        meta: {
          duration_ms: duration,
          request_id: requestId,
          original_slack_results: slackResults.length,
          original_document_results: documentResults.length
        }
      });

    } catch (e) {
      console.error(`❌ [${requestId}] /api/extended-search failed:`, e);
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });

  // Channels API for FE filters
  receiver.router.get("/api/channels", async (req, res) => {
    try {
      const configuredToken =
        process.env.EXTERNAL_POST_BEARER_TOKEN || process.env.BEARER_TOKEN;
      if (configuredToken) {
        const authorizationHeader = req.headers["authorization"] as
          | string
          | undefined;
        const presentedToken = authorizationHeader?.startsWith("Bearer ")
          ? authorizationHeader.substring("Bearer ".length)
          : undefined;
        if (!presentedToken || presentedToken !== configuredToken) {
          res.status(401).json({ ok: false, error: "unauthorized" });
          return;
        }
      }
      const result = await db.query(
        `SELECT channel_id,
                MAX(channel_name) AS channel_name,
                COUNT(*) AS count
         FROM slack_message
         WHERE channel_id IS NOT NULL
         GROUP BY channel_id
         ORDER BY count DESC`
      );
      res.json({ ok: true, channels: result.rows });
    } catch (e) {
      console.error("/api/channels failed:", e);
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });

  // Links API - Enhanced with AI processing and semantic search
  receiver.router.get("/api/links", async (req, res) => {
    try {
      // Authentication check
      const configuredToken =
        process.env.EXTERNAL_POST_BEARER_TOKEN || process.env.BEARER_TOKEN;
      if (configuredToken) {
        const authorizationHeader = req.headers["authorization"] as
          | string
          | undefined;
        const presentedToken = authorizationHeader?.startsWith("Bearer ")
          ? authorizationHeader.substring("Bearer ".length)
          : undefined;
        if (!presentedToken || presentedToken !== configuredToken) {
          res.status(401).json({ ok: false, error: "unauthorized" });
          return;
        }
      }

      // Parse query parameters
      const {
        search,
        channel_name,
        domain,
        status,
        limit,
        offset,
        date_from,
        date_to,
        min_message_count,
        include_messages,
        stats_only
      } = req.query as Record<string, string | undefined>;

      // Return stats only if requested
      if (stats_only === "true") {
        const stats = await linkDatabaseService.getLinkStats();
        res.json({ ok: true, stats });
        return;
      }

      // Parse numeric parameters
      const lim = Math.min(parseInt(limit || "50", 10) || 50, 200);
      const off = Math.max(parseInt(offset || "0", 10) || 0, 0);
      const minMsgCount = min_message_count ? parseInt(min_message_count, 10) : undefined;

      // Parse dates
      let dateRange: { start?: Date; end?: Date } | undefined;
      if (date_from || date_to) {
        dateRange = {};
        if (date_from) {
          dateRange.start = new Date(date_from);
        }
        if (date_to) {
          dateRange.end = new Date(date_to);
        }
      }

      // Build search options
      const options = {
        limit: lim,
        offset: off,
        status: status as 'pending' | 'processing' | 'completed' | 'failed' | undefined,
        domain,
        channelName: channel_name,
        minMessageCount: minMsgCount,
        includeRecentMessages: include_messages === "true",
        dateRange
      };

      let result;
      
      // Perform semantic search if query provided, otherwise chronological
      if (search && search.trim().length > 0) {
        console.log(`🔍 Link semantic search: "${search}"`);
        result = await linkDatabaseService.searchLinksSemanticSearch(search, options);
      } else {
        result = await linkDatabaseService.getLinksChronological(options);
      }

      // Format response to match expected structure
      const formattedLinks = result.links.map(link => ({
        id: link.id,
        url: link.url,
        domain: link.domain,
        title: link.title,
        description: link.description,
        site_name: link.siteName,
        summary: link.summary,
        word_count: link.wordCount,
        message_count: link.messageCount,
        processing_status: link.processingStatus,
        first_seen_at: link.firstSeenAt,
        last_seen_at: link.lastSeenAt,
        relevance_score: link.relevanceScore,
        user_name: link.user_name,
        channel_name: link.channel_name,
        slack_message: link.slack_message,
        recent_messages: link.recentMessages
      }));

      res.json({
        ok: true,
        links: formattedLinks,
        pagination: {
          total: result.total,
          offset: off,
          limit: lim,
          has_more: result.hasMore
        },
        search_type: search ? "semantic" : "chronological"
      });

    } catch (e) {
      console.error("/api/links failed:", e);
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });

  // Link statistics API
  receiver.router.get("/api/links/stats", async (req, res) => {
    try {
      // Authentication check
      const configuredToken =
        process.env.EXTERNAL_POST_BEARER_TOKEN || process.env.BEARER_TOKEN;
      if (configuredToken) {
        const authorizationHeader = req.headers["authorization"] as
          | string
          | undefined;
        const presentedToken = authorizationHeader?.startsWith("Bearer ")
          ? authorizationHeader.substring("Bearer ".length)
          : undefined;
        if (!presentedToken || presentedToken !== configuredToken) {
          res.status(401).json({ ok: false, error: "unauthorized" });
          return;
        }
      }

      const [linkStats, workerStatus] = await Promise.all([
        linkDatabaseService.getLinkStats(),
        linkProcessingWorker.getStatus()
      ]);

      res.json({
        ok: true,
        stats: {
          // Link processing stats
          links: {
            total: linkStats.totalLinks,
            completed: linkStats.completedLinks,
            pending: linkStats.pendingLinks,
            failed: linkStats.failedLinks,
            recent_activity: linkStats.recentActivity,
            top_domains: linkStats.topDomains.slice(0, 10)
          },
          // Worker performance stats
          worker: {
            is_running: workerStatus.isRunning,
            total_processed: workerStatus.metrics.totalProcessed,
            success_rate: workerStatus.metrics.successRate,
            processing_rate: workerStatus.metrics.processingRate,
            average_processing_time: workerStatus.metrics.averageProcessingTime,
            uptime_ms: workerStatus.metrics.uptime
          }
        }
      });

    } catch (e) {
      console.error("/api/links/stats failed:", e);
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });

  // Individual link details API
  receiver.router.get("/api/links/:id", async (req, res) => {
    try {
      // Authentication check
      const configuredToken =
        process.env.EXTERNAL_POST_BEARER_TOKEN || process.env.BEARER_TOKEN;
      if (configuredToken) {
        const authorizationHeader = req.headers["authorization"] as
          | string
          | undefined;
        const presentedToken = authorizationHeader?.startsWith("Bearer ")
          ? authorizationHeader.substring("Bearer ".length)
          : undefined;
        if (!presentedToken || presentedToken !== configuredToken) {
          res.status(401).json({ ok: false, error: "unauthorized" });
          return;
        }
      }

      const linkId = parseInt(req.params.id, 10);
      if (isNaN(linkId)) {
        res.status(400).json({ ok: false, error: "invalid_link_id" });
        return;
      }

      const link = await linkDatabaseService.getLinkById(linkId);
      if (!link) {
        res.status(404).json({ ok: false, error: "link_not_found" });
        return;
      }

      res.json({
        ok: true,
        link: {
          id: link.id,
          url: link.url,
          domain: link.domain,
          title: link.title,
          description: link.description,
          site_name: link.siteName,
          summary: link.summary,
          word_count: link.wordCount,
          message_count: link.messageCount,
          processing_status: link.processingStatus,
          first_seen_at: link.firstSeenAt,
          last_seen_at: link.lastSeenAt,
          user_name: link.user_name,
          channel_name: link.channel_name,
          recent_messages: link.recentMessages
        }
      });

    } catch (e) {
      console.error("/api/links/:id failed:", e);
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });

  // Link reprocessing API
  receiver.router.post("/api/links/reprocess", async (req, res) => {
    try {
      // Authentication check
      const configuredToken =
        process.env.EXTERNAL_POST_BEARER_TOKEN || process.env.BEARER_TOKEN;
      if (configuredToken) {
        const authorizationHeader = req.headers["authorization"] as
          | string
          | undefined;
        const presentedToken = authorizationHeader?.startsWith("Bearer ")
          ? authorizationHeader.substring("Bearer ".length)
          : undefined;
        if (!presentedToken || presentedToken !== configuredToken) {
          res.status(401).json({ ok: false, error: "unauthorized" });
          return;
        }
      }

      const { link_ids, status_filter } = req.body;

      let linksToReprocess: number[] = [];

      if (link_ids && Array.isArray(link_ids)) {
        // Specific link IDs provided
        linksToReprocess = link_ids.filter((id: any) => !isNaN(parseInt(id, 10)));
      } else if (status_filter) {
        // Reprocess links by status (e.g., all failed links)
        const result = await db.query(
          'SELECT id FROM links WHERE processing_status = $1 LIMIT 50',
          [status_filter]
        );
        linksToReprocess = result.rows.map((row: any) => row.id);
      } else {
        res.status(400).json({ 
          ok: false, 
          error: "must_provide_link_ids_or_status_filter" 
        });
        return;
      }

      if (linksToReprocess.length === 0) {
        res.json({
          ok: true,
          message: "no_links_to_reprocess",
          reprocessed: 0
        });
        return;
      }

      // Reset processing status to pending for reprocessing
      await db.query(
        'UPDATE links SET processing_status = $1, error_message = NULL WHERE id = ANY($2)',
        ['pending', linksToReprocess]
      );

      console.log(`🔄 Manually reprocessing ${linksToReprocess.length} links`);

      res.json({
        ok: true,
        message: `queued_${linksToReprocess.length}_links_for_reprocessing`,
        reprocessed: linksToReprocess.length,
        link_ids: linksToReprocess
      });

    } catch (e) {
      console.error("/api/links/reprocess failed:", e);
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });

  // Thread fetch API: return full thread messages for a channel_id + root_ts
  receiver.router.get("/api/thread", async (req, res) => {
    try {
      const configuredToken =
        process.env.EXTERNAL_POST_BEARER_TOKEN || process.env.BEARER_TOKEN;
      if (configuredToken) {
        const authorizationHeader = req.headers["authorization"] as
          | string
          | undefined;
        const presentedToken = authorizationHeader?.startsWith("Bearer ")
          ? authorizationHeader.substring("Bearer ".length)
          : undefined;
        if (!presentedToken || presentedToken !== configuredToken) {
          res.status(401).json({ ok: false, error: "unauthorized" });
          return;
        }
      }

      const { channel_id, root_ts } = req.query as Record<
        string,
        string | undefined
      >;
      if (!channel_id || !root_ts) {
        res
          .status(400)
          .json({ ok: false, error: "channel_id_and_root_ts_required" });
        return;
      }

      const threadRes = await db.query(
        `SELECT m.id,
                m.channel_id,
                m.channel_name,
                m.user_id,
                m.ts,
                LEFT(m.text, 4000) AS text,
                COALESCE(p.display_name, m.user_id) AS author
         FROM slack_message m
         LEFT JOIN LATERAL (
           SELECT display_name
           FROM people
           WHERE slack_user_id = m.user_id
           ORDER BY updated_at DESC NULLS LAST
           LIMIT 1
         ) p ON true
         WHERE m.channel_id = $1
           AND m.text IS NOT NULL
           AND COALESCE(m.subtype,'') NOT IN (
             'channel_join','channel_leave','bot_message','message_changed','message_deleted',
             'thread_broadcast','file_share','channel_topic','channel_purpose','channel_name',
             'channel_archive','channel_unarchive','group_join','group_leave'
           )
           AND (m.ts = $2 OR m.parent_ts = $2 OR m.thread_ts = $2)
         ORDER BY m.ts ASC, m.id ASC`,
        [channel_id, root_ts]
      );

      res.json({
        ok: true,
        channel_id,
        thread_root_ts: root_ts,
        messages: threadRes.rows,
      });
    } catch (e) {
      console.error("/api/thread failed:", e);
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });
}

// Validate required environment variables
if (!process.env.SLACK_SIGNING_SECRET) {
  throw new Error(
    "Required environment variable SLACK_SIGNING_SECRET is not set"
  );
}

// Check if we have OAuth credentials OR bot token
// TEMPORARY: Force single-workspace mode to fix DM issue
const hasOAuth = false; // process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET;
const hasBotToken = process.env.SLACK_BOT_TOKEN;

if (!hasOAuth && !hasBotToken) {
  console.error("❌ Missing Slack credentials. You need either:");
  console.error(
    "   1. OAuth: SLACK_CLIENT_ID + SLACK_CLIENT_SECRET (for multi-workspace)"
  );
  console.error("   2. Bot Token: SLACK_BOT_TOKEN (for single workspace)");
  process.exit(1);
}

// Create app with or without OAuth receiver
console.log("🔧 App setup:", {
  hasReceiver: !!receiver,
  hasOAuth: hasOAuth,
  hasBotToken: hasBotToken,
  socketMode: false,
});

export const app = receiver
  ? new App({
      receiver,
      authorize: async ({ teamId }) => {
        console.log("🔐 OAuth authorize called for team:", teamId);

        // Try to get token from OAuth service first
        if (teamId) {
          const token = await oauthService.getBotToken(teamId);
          if (token) {
            console.log("✅ Found OAuth bot token for team:", teamId);
            return { botToken: token };
          }
          console.log("⚠️ No OAuth token found for team:", teamId);
        }

        // Fallback to env token for single workspace mode
        if (process.env.SLACK_BOT_TOKEN) {
          console.log("✅ Using fallback env bot token for team:", teamId);
          return { botToken: process.env.SLACK_BOT_TOKEN };
        }

        console.error(
          `❌ No token available for team ${teamId} - neither OAuth nor env token found`
        );
        throw new Error(`No token found for team ${teamId}`);
      },
    })
  : new App({
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
      token: process.env.SLACK_BOT_TOKEN!,
      socketMode: false,
    });

console.log("✅ Slack App created successfully");

// Get bot user ID to prevent infinite loops
let botUserId: string | null = null;
let botTeamId: string | null = null;
let botTeamName: string | null = null;

// Lightweight cache for user display names to enrich logs without spamming Slack API
const userNameCache = new Map<
  string,
  { realName: string; displayName: string; updatedAt: number }
>();
const USER_NAME_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getUserNames(
  client: any,
  userId: string
): Promise<{ realName: string; displayName: string }> {
  const cached = userNameCache.get(userId);
  const now = Date.now();
  if (cached && now - cached.updatedAt < USER_NAME_CACHE_TTL_MS) {
    return { realName: cached.realName, displayName: cached.displayName };
  }
  try {
    const info = await client.users.info({ user: userId });
    const realName = info.user?.real_name || info.user?.name || "Unknown";
    const displayName = info.user?.profile?.display_name || realName;
    userNameCache.set(userId, { realName, displayName, updatedAt: now });
    return { realName, displayName };
  } catch {
    return { realName: "Unknown", displayName: userId };
  }
}

// Rate limiting to prevent spam/loops (user -> last message timestamp)
const userMessageTimestamps = new Map<string, number>();
const MESSAGE_COOLDOWN_MS = 2000; // 2 seconds between messages per user
(async () => {
  try {
    const authTest = await app.client.auth.test();
    botUserId = authTest.user_id as string;
    botTeamId = (authTest as any).team_id || null;
    botTeamName = (authTest as any).team || null;
    console.log("🤖 Bot identity:", {
      botUserId,
      botTeamId,
      botTeamName,
    });
  } catch (error) {
    console.error("❌ Failed to get bot user ID:", error);
  }
})();

// Helper function to check if user is admin
const isAdmin = (userId: string): boolean => {
  const adminIds = (process.env.ADMIN_USER_ID || "")
    .split(",")
    .map((id) => id.trim());
  return adminIds.includes(userId);
};

// Helper function to format helper results with AI-generated per-user summaries
const formatHelperResults = async (
  helpers: any[],
  needText: string,
  slackClient?: any,
  capturePrompt?: (type: string, content: string) => void
) => {
  if (helpers.length === 0) {
    return {
      text: "I couldn't find any helpers for your specific need right now.",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "🔍 I couldn't find any helpers for your specific need right now. Try rephrasing your request or check back later as more people add skills to their profiles.",
          },
        },
      ],
    };
  }

  // Build blocks for each helper
  const helperBlocks: any[] = [];

  const topHelpers = helpers.slice(0, 5);

  // Generate AI summaries in parallel, enriching with skills, channels, and recent messages
  const helperContexts = await Promise.all(
    topHelpers.map(async (helper) => {
      try {
        const [personRow, allSkillsRows, channels] = await Promise.all([
          db.getPerson(helper.slack_user_id || helper.id),
          db.getPersonSkills(helper.slack_user_id || helper.id),
          (async () => {
            if (!helper.slack_user_id)
              return [] as Array<{
                channel_name: string | null;
                summary: string | null;
              }>;
            const ch = await db.getChannelsByMemberSlackIds([
              helper.slack_user_id,
            ]);
            return ch.map((c) => ({
              channel_name: c.channel_name,
              summary: c.summary,
            }));
          })(),
        ]);
        const messages = helper.slack_user_id
          ? await db.getUserMessages(helper.slack_user_id, 100)
          : [];
        const skills = (allSkillsRows || []).map((r: any) => r.skill);

        // Try to fetch a small profile image via Slack API if available
        let imageUrl: string | null = null;
        try {
          if (
            slackClient &&
            helper.slack_user_id &&
            helper.slack_user_id.startsWith("U")
          ) {
            const info = await slackClient.users.info({
              user: helper.slack_user_id,
            });
            const prof = (info as any).user?.profile || {};
            // Prefer higher-resolution variants for sharper rendering; Slack will downscale in UI
            imageUrl =
              prof.image_512 ||
              prof.image_192 ||
              prof.image_72 ||
              prof.image_48 ||
              prof.image_original ||
              null;
          }
        } catch {}

        const summary = await embeddingService.generateFitSummaryForHelper({
          needText,
          helper: {
            id: helper.id,
            name: helper.name,
            slack_user_id: helper.slack_user_id,
            expertise: helper.expertise,
            projects: helper.projects,
            offers: helper.offers,
            skills,
            channels,
            messages,
            asks: personRow?.asks,
            most_interested_in: personRow?.most_interested_in,
            confusion: personRow?.confusion,
          },
          capturePrompt,
        });
        return { summary, imageUrl };
      } catch (e) {
        console.warn("⚠️ Failed to generate fit summary for helper", {
          helper: helper.name,
          error: String(e),
        });
        return {
          summary: null as string | null,
          imageUrl: null as string | null,
        };
      }
    })
  );

  topHelpers.forEach((helper, idx) => {
    // Use slack_user_id for proper user mentions, fallback to name
    const userDisplay =
      helper.slack_user_id && helper.slack_user_id.startsWith("U")
        ? `<@${helper.slack_user_id}>`
        : helper.name;
    const aiSummary = helperContexts[idx]?.summary || null;
    const imageUrl = helperContexts[idx]?.imageUrl || null;

    // Add main section with name and AI summary
    helperBlocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${userDisplay}*${aiSummary ? "\n" + aiSummary : ""}`,
      },
      ...(imageUrl
        ? {
            accessory: {
              type: "image",
              image_url: imageUrl,
              alt_text: helper.name,
            },
          }
        : {}),
    });

    // Add skills in context block if they have any
    if (helper.skills.length > 0) {
      const skillsText = helper.skills
        .slice(0, 3)
        .map((skillObj: HelperSkill) => {
          // Bold skills with >70% relevance
          if (skillObj.score > 0.7) {
            return `*${skillObj.skill}*`;
          } else {
            return skillObj.skill;
          }
        })
        .join(", ");

      helperBlocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Skills: ${skillsText}`,
          },
        ],
      });
    }

    // Add a small divider between helpers
    helperBlocks.push({
      type: "divider",
    });
  });

  return {
    text: `Found ${helpers.length} people who might help with: "${needText}"`,
    blocks: [
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🎯 *Found ${helpers.length} people who might help with:*\n_"${needText}"_`,
        },
      },
      {
        type: "divider",
      },
      ...helperBlocks,
    ],
  };
};

// App home opened event
app.event("app_home_opened", async ({ event, client }) => {
  try {
    const userId = event.user;
    console.log(`📱 App home opened by user: ${userId}`);

    // Ensure user exists in database
    const userInfo = await client.users.info({ user: userId });
    await db.createPerson(
      userId,
      userInfo.user?.real_name || userInfo.user?.name || "Unknown"
    );

    // Get user's skills
    const userSkills = await db.getPersonSkills(userId);
    console.log(`📱 User ${userId} has ${userSkills.length} skills`);

    // Build blocks for the home view
    const blocks: any[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Welcome to Offers and Asks! 🤝*\n\nConnect with teammates who have the skills you need, or help others with your expertise.",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: " ",
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: " ",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Your Skills*",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text:
              userSkills.length > 0
                ? `Skills: ${userSkills.map((s) => s.skill).join(", ")}`
                : 'No skills added yet. Click "Manage Skills" to add some!',
          },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Manage Skills",
            },
            action_id: "manage_skills",
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: " ",
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: " ",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Need Help?*",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "💡 You can also DM me directly with what you need help with!",
          },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Find Helpers",
            },
            action_id: "find_helpers",
            style: "primary",
          },
        ],
      },
    ];

    // Add admin section if user is admin
    if (isAdmin(userId)) {
      // Get weekly stats
      const stats = await helperMatchingService.getWeeklyStats();

      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: " ",
          },
        },
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: " ",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*🔧 Admin Controls*",
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `📊 Quick Stats: ${stats.totalHelpers} helpers • ${
                stats.totalNeeds
              } needs this week • Top skill: ${
                stats.topSkills[0]?.skill || "N/A"
              }`,
            },
          ],
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "📨 Send Weekly Prompts",
              },
              action_id: "admin_send_weekly",
              style: "primary",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "📊 View Stats",
              },
              action_id: "admin_view_stats",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "🧪 Test DM",
              },
              action_id: "admin_test_dm",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "👥 List Users",
              },
              action_id: "admin_list_users",
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "🔄 Sync Users",
              },
              action_id: "admin_sync_users",
            },
          ],
        }
      );
    }

    console.log(`📱 Publishing home view with ${blocks.length} blocks`);

    const publishResult = await client.views.publish({
      user_id: userId,
      view: {
        type: "home",
        blocks,
      },
    });

    console.log(
      `📱 Home view published successfully for user ${userId}:`,
      publishResult.ok
    );
  } catch (error) {
    console.error(`❌ Error in app_home_opened for user ${event.user}:`, error);
    await errorHandler.handle(error, "app_home_opened", { userId: event.user });

    // Try to at least show a simple message if view publishing fails
    try {
      await client.views.publish({
        user_id: event.user,
        view: {
          type: "home",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "*Welcome to Offers and Asks! 🤝*\n\nDM me with what you need help with, and I'll find teammates with matching skills.\n\nExample: 'I need help with React testing'",
              },
            },
          ],
        },
      });
    } catch (fallbackError) {
      console.error(`❌ Even fallback view failed:`, fallbackError);
    }
  }
});

// Admin action: Send weekly prompts
app.action("admin_send_weekly", async ({ ack, body, client }) => {
  await ack();

  const userId = (body as any).user.id;
  if (!isAdmin(userId)) {
    return;
  }

  try {
    // Show loading message
    await client.chat.postMessage({
      channel: userId,
      text: "⏳ Sending weekly prompts to all enabled users...",
    });

    // Run the weekly prompt job
    await sendWeeklyPrompts();

    await client.chat.postMessage({
      channel: userId,
      text: "✅ Weekly prompts sent successfully!",
    });
  } catch (error) {
    await client.chat.postMessage({
      channel: userId,
      text: `❌ Failed to send weekly prompts: ${error}`,
    });
    await errorHandler.handle(error, "admin_send_weekly", { userId });
  }
});

// Admin action: View stats
app.action("admin_view_stats", async ({ ack, body, client }) => {
  await ack();

  const userId = (body as any).user.id;
  if (!isAdmin(userId)) {
    return;
  }

  try {
    const stats = await helperMatchingService.getWeeklyStats();
    const enabledUsers = await db.getAllEnabledPeople();

    const topSkillsText = stats.topSkills
      .slice(0, 10)
      .map((s, i) => `${i + 1}. ${s.skill} (${s.count} people)`)
      .join("\n");

    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: "modal",
        title: {
          type: "plain_text",
          text: "📊 System Statistics",
        },
        close: {
          type: "plain_text",
          text: "Close",
        },
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*📈 Overall Stats*",
            },
          },
          {
            type: "section",
            fields: [
              {
                type: "mrkdwn",
                text: `*Total Helpers:*\n${stats.totalHelpers}`,
              },
              {
                type: "mrkdwn",
                text: `*Enabled Users:*\n${enabledUsers.length}`,
              },
              {
                type: "mrkdwn",
                text: `*Needs This Week:*\n${stats.totalNeeds}`,
              },
              {
                type: "mrkdwn",
                text: `*Avg Match Score:*\n${stats.averageMatchScore.toFixed(
                  2
                )}`,
              },
            ],
          },
          {
            type: "divider",
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*🏆 Top Skills*\n${
                topSkillsText || "No skills data available"
              }`,
            },
          },
        ],
      },
    });
  } catch (error) {
    await errorHandler.handle(error, "admin_view_stats", { userId });
  }
});

// Admin action: Test DM
app.action("admin_test_dm", async ({ ack, body, client }) => {
  await ack();

  const userId = (body as any).user.id;
  if (!isAdmin(userId)) {
    return;
  }

  try {
    await client.chat.postMessage({
      channel: userId,
      text: "🧪 Test DM from Offers and Asks bot!",
      blocks: [
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: '🧪 *Test DM successful!*\n\nYou can send me messages like:\n• "I need help with React testing"\n• "Looking for someone who knows PostgreSQL"\n• "Need assistance with Docker deployment"',
          },
        },
      ],
    });
  } catch (error: any) {
    console.error(`Admin test DM failed for ${userId}:`, error.message);
    await errorHandler.handle(error, "admin_test_dm", { userId });
  }
});

// Admin action: List workspace users
app.action("admin_list_users", async ({ ack, body, client }) => {
  await ack();

  const userId = (body as any).user.id;
  if (!isAdmin(userId)) {
    return;
  }

  try {
    const userService = new UserService(client);
    const users = await userService.fetchAllUsers();
    const userList = userService.formatUserList(users);

    // Split user list into chunks if it's too long for a single message
    const chunks = userList.match(/(?:[^\n]+\n?){1,50}/g) || [];

    await client.chat.postMessage({
      channel: userId,
      text: `Found ${users.length} users in workspace`,
      blocks: [
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `👥 *Found ${users.length} users in workspace*\n\nFormat: *Real Name* (display_name) - \`slack_id\``,
          },
        },
      ],
    });

    // Send user list in chunks to avoid message size limits
    for (let i = 0; i < chunks.length; i++) {
      const isLastChunk = i === chunks.length - 1;
      const blocks: any[] = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: chunks[i].trim(),
          },
        },
      ];

      // Add context on last chunk
      if (isLastChunk) {
        blocks.push({
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Use the "Sync Users" button to add all users to the database`,
            },
          ],
        });
      }

      await client.chat.postMessage({
        channel: userId,
        text: `Users ${i * 50 + 1}-${Math.min((i + 1) * 50, users.length)}`,
        blocks,
      });
    }
  } catch (error: any) {
    console.error(`Admin list users failed for ${userId}:`, error.message);
    await errorHandler.handle(error, "admin_list_users", { userId });
  }
});

// Admin action: Sync workspace users to database
app.action("admin_sync_users", async ({ ack, body, client }) => {
  await ack();

  const userId = (body as any).user.id;
  if (!isAdmin(userId)) {
    return;
  }

  try {
    await client.chat.postMessage({
      channel: userId,
      text: "Starting user sync...",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "🔄 *Starting user sync...*\n\nThis may take a moment.",
          },
        },
      ],
    });

    const userService = new UserService(client);
    const { added, updated } = await userService.syncUsersToDatabase();

    await client.chat.postMessage({
      channel: userId,
      text: `User sync complete: ${added} added, ${updated} updated`,
      blocks: [
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `✅ *User sync complete!*\n\n• *Added:* ${added} users\n• *Updated:* ${updated} users`,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "All workspace users have been synced to the database",
            },
          ],
        },
      ],
    });
  } catch (error: any) {
    console.error(`Admin sync users failed for ${userId}:`, error.message);
    await errorHandler.handle(error, "admin_sync_users", { userId });

    await client.chat.postMessage({
      channel: userId,
      text: "❌ User sync failed. Check logs for details.",
    });
  }
});

// Handle direct messages - process needs and reply in thread
console.log("🚀 Registering DM message handler...");
app.message(async ({ message, client, say }) => {
  console.log("💬 MESSAGE HANDLER TRIGGERED!", {
    teamId: botTeamId,
    teamName: botTeamName,
  });
  try {
    console.log("📨 Received message:", {
      channel_type: (message as any).channel_type,
      subtype: (message as any).subtype,
      user: (message as any).user,
      bot_id: (message as any).bot_id,
      text: (message as any).text?.substring(0, 50),
      channel: (message as any).channel,
      teamId: botTeamId,
      teamName: botTeamName,
    });

    // Comprehensive bot message filtering to prevent infinite loops
    const channelType = (message as any).channel_type;
    const channel = (message as any).channel;
    const subtype = (message as any).subtype;
    const user = (message as any).user;
    const botId = (message as any).bot_id;

    // Check if this is a DM
    const isDM = channelType === "im" || (channel && channel.startsWith("D"));
    if (!isDM) {
      console.log("📨 Skipping - not a DM channel:", { channelType, channel });
      return;
    }

    // Filter out ALL bot messages to prevent infinite loops
    const isFromThisBot = botUserId && user === botUserId;
    const isFromAnyBot =
      !!botId ||
      subtype === "bot_message" ||
      (message as any).app_id ||
      (message as any).bot_profile;
    const isSystemMessage =
      subtype === "message_changed" ||
      subtype === "message_deleted" ||
      subtype === "channel_join" ||
      subtype === "channel_leave" ||
      subtype === "file_share" ||
      subtype === "thread_broadcast";
    const hasNoUser = !user; // System messages often have no user

    if (isFromThisBot || isFromAnyBot || isSystemMessage || hasNoUser) {
      console.log("📨 Skipping bot/system message:", {
        isFromThisBot,
        isFromAnyBot,
        isSystemMessage,
        hasNoUser,
        user,
        botId,
        subtype,
        botUserId,
        textPreview: (message as any).text?.substring(0, 50),
      });
      return;
    }

    const userId = user; // Use the already extracted user
    const messageText = (message as any).text;
    const ts = (message as any).ts;

    // Additional safety checks
    if (!userId || !messageText || !ts) {
      console.log("📨 Skipping - missing required fields:", {
        userId: !!userId,
        messageText: !!messageText,
        ts: !!ts,
      });
      return;
    }

    // Resolve user names for richer logging
    const { realName, displayName } = await getUserNames(client, userId);

    // Rate limiting check to prevent spam/loops
    const now = Date.now();
    const lastMessageTime = userMessageTimestamps.get(userId) || 0;
    if (now - lastMessageTime < MESSAGE_COOLDOWN_MS) {
      console.log("📨 Skipping - rate limited:", {
        userId,
        cooldownMs: now - lastMessageTime,
        nextAllowedInMs: MESSAGE_COOLDOWN_MS - (now - lastMessageTime),
        teamId: botTeamId,
      });
      return;
    }
    userMessageTimestamps.set(userId, now);

    // Skip if message is too short or looks like a command/system message
    if (
      messageText.length < 3 ||
      messageText.startsWith("/") ||
      messageText.startsWith("!")
    ) {
      await say({
        thread_ts: ts,
        text: "Please describe what you need help with in more detail. For example: 'I need help setting up React testing with Jest'",
      });
      return;
    }

    // We've passed all filters - this is a legitimate user message to process
    console.log("✅ Processing legitimate user message:", {
      userId,
      userName: realName,
      displayName,
      channel,
      threadTs: ts,
      messageChars: messageText.length,
      messagePreview: messageText.substring(0, 100),
      teamId: botTeamId,
    });

    // Check for commands
    if (
      messageText.toLowerCase().includes("/help") ||
      messageText.toLowerCase() === "help"
    ) {
      await say({
        thread_ts: ts,
        text: "Here's how to use me:",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*How to use Offers and Asks:*\n\n• Send me a message describing what you need help with\n• I'll find teammates with matching skills\n• Visit the app home to manage your skills\n\n*Example messages:*\n• 'I need help with React testing'\n• 'Looking for PostgreSQL optimization tips'\n• 'Need someone who knows Kubernetes'",
            },
          },
        ],
      });
      return;
    }

    // Send thinking message
    const thinkingMsg = await client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: "🔍 Looking for helpers...",
    });
    console.log("🧵 Posted thinking message:", {
      channel,
      threadTs: ts,
      messageTs: (thinkingMsg as any).ts,
    });

    try {
      // If admin, capture all prompts and send a .txt report back
      const promptLines: string[] = [];
      const capturePrompt = (type: string, content: string) => {
        const ts = new Date().toISOString();
        promptLines.push(
          `===== ${type.toUpperCase()} @ ${ts} =====\n${content}\n\n`
        );
      };

      // Find helpers for this need
      const helpers = await helperMatchingService.findHelpers(
        messageText,
        userId,
        undefined,
        isAdmin(userId) ? capturePrompt : undefined
      );

      // Format and send results
      const results = await formatHelperResults(
        helpers,
        messageText,
        client,
        isAdmin(userId) ? capturePrompt : undefined
      );

      // Update the thinking message with results
      await client.chat.update({
        channel,
        ts: thinkingMsg.ts!,
        ...results,
      });
      console.log("📤 Results posted:", {
        channel,
        updatedTs: thinkingMsg.ts,
        helpersReturned: helpers.length,
        topHelperNames: helpers.slice(0, 3).map((h) => h.name),
      });

      // If admin, send prompts as a .txt attachment for review
      if (isAdmin(userId) && promptLines.length > 0) {
        try {
          const report = promptLines.join("\n");
          // Prefer modern upload flow: files.getUploadURLExternal + completeUploadExternal
          const filename = `llm-prompts-${Date.now()}.txt`;
          const getUrl = await client.files.getUploadURLExternal({
            filename,
            length: Buffer.byteLength(report, "utf8"),
          } as any);
          const uploadUrl = (getUrl as any).upload_url as string;
          const fileId = (getUrl as any).file_id as string;
          await fetch(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: Buffer.from(report, "utf8"),
          } as any);
          await client.files.completeUploadExternal({
            files: [
              {
                id: fileId,
                title: "LLM Prompts Report",
              },
            ],
            channel_id: (channel as string) || userId,
            initial_comment:
              "Here are the prompts used (skills, rerank, fit summaries).",
          } as any);
        } catch (e) {
          console.warn("⚠️ Failed to upload prompt report:", e);
        }
      }

      // Weekly need is stored within HelperMatchingService to avoid duplication
    } catch (error) {
      // Update thinking message with error
      await client.chat.update({
        channel,
        ts: thinkingMsg.ts!,
        text: "❌ Sorry, I encountered an error while looking for helpers. Please try again or visit the app home.",
      });
      throw error;
    }
  } catch (error) {
    await errorHandler.handle(error, "message_handler", {
      channel: (message as any).channel,
      user: (message as any).user,
    });
  }
});

// Handle "Find Helpers" button
app.action("find_helpers", async ({ ack, body, client }) => {
  await ack();

  try {
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: "modal",
        callback_id: "need_help_modal",
        title: {
          type: "plain_text",
          text: "What do you need?",
        },
        submit: {
          type: "plain_text",
          text: "Find Helpers",
        },
        close: {
          type: "plain_text",
          text: "Cancel",
        },
        blocks: [
          {
            type: "input",
            block_id: "need_input",
            element: {
              type: "plain_text_input",
              action_id: "need_text",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: 'Describe what you need help with... (e.g., "Setting up React testing with Jest", "Optimizing PostgreSQL queries")',
              },
            },
            label: {
              type: "plain_text",
              text: "Your need",
            },
          },
        ],
      },
    });
  } catch (error) {
    await errorHandler.handle(error, "find_helpers", {
      userId: (body as any).user.id,
    });
  }
});

// Handle "Need Help?" button from weekly DM
app.action("open_need_modal", async ({ ack, body, client }) => {
  await ack();

  try {
    // Reuse the same modal as find_helpers
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: "modal",
        callback_id: "need_help_modal",
        title: {
          type: "plain_text",
          text: "What do you need?",
        },
        submit: {
          type: "plain_text",
          text: "Find Helpers",
        },
        close: {
          type: "plain_text",
          text: "Cancel",
        },
        blocks: [
          {
            type: "input",
            block_id: "need_input",
            element: {
              type: "plain_text_input",
              action_id: "need_text",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: 'Describe what you need help with... (e.g., "Setting up React testing with Jest", "Optimizing PostgreSQL queries")',
              },
            },
            label: {
              type: "plain_text",
              text: "Your need",
            },
          },
        ],
      },
    });
  } catch (error) {
    await errorHandler.handle(error, "open_need_modal", {
      userId: (body as any).user.id,
    });
  }
});

// Handle "Manage Skills" button
app.action("manage_skills", async ({ ack, body, client }) => {
  await ack();

  try {
    const userId = (body as any).user.id;
    const userSkills = await db.getPersonSkills(userId);

    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: "modal",
        callback_id: "manage_skills_modal",
        title: {
          type: "plain_text",
          text: "Manage Your Skills",
        },
        submit: {
          type: "plain_text",
          text: "Save",
        },
        close: {
          type: "plain_text",
          text: "Cancel",
        },
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Current Skills:*",
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text:
                  userSkills.length > 0
                    ? userSkills.map((s) => `• ${s.skill}`).join("\n")
                    : "No skills added yet.",
              },
            ],
          },
          {
            type: "divider",
          },
          {
            type: "input",
            block_id: "skills_input",
            element: {
              type: "plain_text_input",
              action_id: "skills_text",
              placeholder: {
                type: "plain_text",
                text: "React, Node.js, PostgreSQL, Machine Learning",
              },
            },
            label: {
              type: "plain_text",
              text: "Add new skills (comma-separated)",
            },
            optional: true,
          },
          {
            type: "input",
            block_id: "remove_skills",
            element: {
              type: "plain_text_input",
              action_id: "remove_text",
              placeholder: {
                type: "plain_text",
                text: "Enter skills to remove, comma-separated",
              },
            },
            label: {
              type: "plain_text",
              text: "Remove skills (optional)",
            },
            optional: true,
          },
        ],
      },
    });
  } catch (error) {
    await errorHandler.handle(error, "manage_skills", {
      userId: (body as any).user.id,
    });
  }
});

// Handle need help modal submission
app.view("need_help_modal", async ({ ack, body, view, client }) => {
  await ack();

  try {
    const userId = body.user.id;
    const needText = view.state.values.need_input?.need_text?.value;

    if (!needText) {
      return;
    }

    // If admin, capture all prompts and send a .txt report back
    const promptLines: string[] = [];
    const capturePrompt = (type: string, content: string) => {
      const ts = new Date().toISOString();
      promptLines.push(
        `===== ${type.toUpperCase()} @ ${ts} =====\n${content}\n\n`
      );
    };

    // Find helpers for this need
    const helpers = await helperMatchingService.findHelpers(
      needText,
      userId,
      undefined,
      isAdmin(userId) ? capturePrompt : undefined
    );

    // Format and send results directly to user (using user ID as channel)
    const results = await formatHelperResults(
      helpers,
      needText,
      client,
      isAdmin(userId) ? capturePrompt : undefined
    );
    await client.chat.postMessage({
      channel: userId,
      ...results,
    });

    // If admin, upload the prompts as a .txt file
    if (isAdmin(userId) && promptLines.length > 0) {
      try {
        const report = promptLines.join("\n");
        const filename = `llm-prompts-${Date.now()}.txt`;
        const getUrl = await client.files.getUploadURLExternal({
          filename,
          length: Buffer.byteLength(report, "utf8"),
        } as any);
        const uploadUrl = (getUrl as any).upload_url as string;
        const fileId = (getUrl as any).file_id as string;
        await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: Buffer.from(report, "utf8"),
        } as any);
        await client.files.completeUploadExternal({
          files: [
            {
              id: fileId,
              title: "LLM Prompts Report",
            },
          ],
          channel_id: userId,
          initial_comment:
            "Here are the prompts used (skills, rerank, fit summaries).",
        } as any);
      } catch (e) {
        console.warn("⚠️ Failed to upload prompt report:", e);
      }
    }
  } catch (error) {
    await errorHandler.handle(error, "need_help_modal", {
      userId: body.user.id,
    });
  }
});

// Handle skills modal submission
app.view("manage_skills_modal", async ({ ack, body, view, client }) => {
  await ack();

  try {
    const userId = body.user.id;
    const addSkillsText = view.state.values.skills_input?.skills_text?.value;
    const removeSkillsText =
      view.state.values.remove_skills?.remove_text?.value;

    const addedSkills = [];
    const removedSkills = [];

    // Add new skills
    if (addSkillsText) {
      const newSkills = addSkillsText
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const skill of newSkills) {
        let skillRecord = await db.getSkillByText(skill);
        if (!skillRecord) {
          const skillId = await db.createSkill(skill);
          const embedding = await embeddingService.generateEmbedding(skill);
          await db.updateSkillEmbedding(skillId, embedding);
          skillRecord = { id: skillId, skill };
        }

        await db.addPersonSkill(userId, skillRecord.id);
        addedSkills.push(skill);
      }
    }

    // Remove skills
    if (removeSkillsText) {
      const skillsToRemove = removeSkillsText
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const skill of skillsToRemove) {
        const skillRecord = await db.getSkillByText(skill);
        if (skillRecord) {
          await db.removePersonSkill(userId, skillRecord.id);
          removedSkills.push(skill);
        }
      }
    }

    // Skills updated - home page refresh will show the changes, no need for DM confirmation

    // Refresh the app home to show updated skills
    try {
      // Get updated user skills
      const updatedUserSkills = await db.getPersonSkills(userId);

      // Build blocks for the home view (same logic as app_home_opened)
      const blocks: any[] = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Welcome to Offers and Asks! 🤝*\n\nConnect with teammates who have the skills you need, or help others with your expertise.",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: " ",
          },
        },
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: " ",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Your Skills*",
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text:
                updatedUserSkills.length > 0
                  ? `Skills: ${updatedUserSkills
                      .map((s) => s.skill)
                      .join(", ")}`
                  : 'No skills added yet. Click "Manage Skills" to add some!',
            },
          ],
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Manage Skills",
              },
              action_id: "manage_skills",
            },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: " ",
          },
        },
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: " ",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Need Help?*",
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "💡 You can also DM me directly with what you need help with!",
            },
          ],
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Find Helpers",
              },
              action_id: "find_helpers",
              style: "primary",
            },
          ],
        },
      ];

      // Add admin section if user is admin
      if (isAdmin(userId)) {
        const stats = await helperMatchingService.getWeeklyStats();
        blocks.push(
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: " ",
            },
          },
          {
            type: "divider",
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: " ",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*🔧 Admin Controls*",
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `📊 Quick Stats: ${stats.totalHelpers} helpers • ${
                  stats.totalNeeds
                } needs this week • Top skill: ${
                  stats.topSkills[0]?.skill || "N/A"
                }`,
              },
            ],
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "📨 Send Weekly Prompts",
                },
                action_id: "admin_send_weekly",
                style: "primary",
              },
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "📊 View Stats",
                },
                action_id: "admin_view_stats",
              },
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "🧪 Test DM",
                },
                action_id: "admin_test_dm",
              },
            ],
          }
        );
      }

      // Refresh the home view
      await client.views.publish({
        user_id: userId,
        view: {
          type: "home",
          blocks,
        },
      });

      console.log(
        `📱 Home view refreshed for user ${userId} after skills update`
      );
    } catch (homeRefreshError: any) {
      console.warn(
        `Could not refresh home view for ${userId}:`,
        homeRefreshError.message
      );
      // Don't fail the whole operation if home refresh fails
    }
  } catch (error) {
    await errorHandler.handle(error, "manage_skills_modal", {
      userId: body.user.id,
    });
  }
});

// Add comprehensive event logging to debug what events are being received
app.event(/.+/, async ({ event, client }) => {
  console.log("🔍 RECEIVED EVENT:", {
    type: event.type,
    user: (event as any).user,
    channel: (event as any).channel,
    channel_type: (event as any).channel_type,
    subtype: (event as any).subtype,
    text: (event as any).text?.substring(0, 50),
    timestamp: new Date().toISOString(),
  });
});

// Add middleware to log all incoming requests
if (receiver) {
  receiver.router.use((req, res, next) => {
    console.log("🌐 INCOMING REQUEST:", {
      method: req.method,
      url: req.url,
      headers: {
        "x-slack-signature": req.headers["x-slack-signature"]
          ? "present"
          : "missing",
        "x-slack-request-timestamp": req.headers["x-slack-request-timestamp"]
          ? "present"
          : "missing",
        "content-type": req.headers["content-type"],
      },
      userAgent: req.headers["user-agent"]?.substring(0, 50),
    });

    // Specifically log Slack webhook events
    if (req.url === "/slack/events" && req.method === "POST") {
      console.log("🎯 SLACK EVENT WEBHOOK HIT!");

      // Log body for Slack events (be careful with size)
      if (req.body) {
        console.log("📦 Event body type:", req.body.type);
        console.log("📦 Event:", req.body.event?.type);
      }
    }

    next();
  });
}

// Error handling for unhandled events
app.error(async (error) => {
  console.error("Slack app error:", error);
  await errorHandler.handle(error, "slack_app_error");
});

export default app;
