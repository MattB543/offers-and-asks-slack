import { config } from "dotenv";
import { db } from "../lib/database";
import * as fs from "fs";
import * as path from "path";

config();

const TARGET_USER_ID = "U098C1Z4V32";
const OUTPUT_FILE = "user-threads-export.txt";

interface Message {
  channel_id: string;
  channel_name: string;
  ts: string;
  thread_ts: string | null;
  user_id: string;
  user_name: string;
  text: string;
  is_reply: boolean;
}

interface Thread {
  channel_id: string;
  channel_name: string;
  thread_ts: string;
  messages: Message[];
}

async function getUserThreads(userId: string): Promise<Thread[]> {
  console.log(`🔍 Finding all threads where user ${userId} participated in replies...`);
  
  // Find all unique threads where the user has posted a REPLY (not just parent message)
  const threadQuery = `
    SELECT DISTINCT 
      thread_ts as thread_id,
      channel_id,
      channel_name
    FROM slack_message
    WHERE user_id = $1
      AND thread_ts IS NOT NULL
      AND is_reply = true
      AND text IS NOT NULL
      AND text != ''
    ORDER BY thread_ts DESC
  `;
  
  const threadResult = await db.query(threadQuery, [userId]);
  console.log(`📊 Found ${threadResult.rows.length} threads where user replied`);
  
  const threads: Thread[] = [];
  
  // For each thread, get all messages in that thread
  for (const row of threadResult.rows) {
    const threadTs = row.thread_id;
    const channelId = row.channel_id;
    
    // Get all messages in this thread (including the parent)
    const messagesQuery = `
      SELECT 
        channel_id,
        channel_name,
        ts,
        thread_ts,
        user_id,
        user_name,
        text,
        is_reply
      FROM slack_message
      WHERE channel_id = $1
        AND (ts = $2 OR thread_ts = $2)
        AND text IS NOT NULL
      ORDER BY ts ASC
    `;
    
    const messagesResult = await db.query(messagesQuery, [channelId, threadTs]);
    
    // Only include if there's more than one message (actual thread conversation)
    if (messagesResult.rows.length > 1) {
      const allMessages = messagesResult.rows as Message[];
      
      // Find the last message from the target user
      let lastUserMessageIndex = -1;
      for (let i = allMessages.length - 1; i >= 0; i--) {
        if (allMessages[i].user_id === userId) {
          lastUserMessageIndex = i;
          break;
        }
      }
      
      // Only include messages up to (and including) the user's last message
      if (lastUserMessageIndex >= 0) {
        const truncatedMessages = allMessages.slice(0, lastUserMessageIndex + 1);
        threads.push({
          channel_id: channelId,
          channel_name: row.channel_name || "unknown-channel",
          thread_ts: threadTs,
          messages: truncatedMessages
        });
      }
    }
  }
  
  return threads;
}

function formatThreadsForExport(threads: Thread[], targetUserId: string): string {
  const lines: string[] = [];
  
  for (const thread of threads) {
    // Thread messages
    for (const msg of thread.messages) {
      // Format username (simple "Me:" for target user)
      let userLabel: string;
      if (msg.user_id === targetUserId) {
        userLabel = "Me";
      } else {
        const fullName = msg.user_name || msg.user_id || "Unknown";
        // Remove last name - keep only first name
        userLabel = removeLastName(fullName);
      }
      
      // Clean up text
      const cleanText = cleanMessageText(msg.text);
      
      // Format message
      lines.push(`${userLabel}: ${cleanText}`);
    }
    
    // Thread separator
    lines.push("---");
  }
  
  return lines.join('\n');
}

function removeLastName(fullName: string): string {
  // Split by space and take only the first part
  const parts = fullName.trim().split(/\s+/);
  return parts[0] || "Unknown";
}

function cleanMessageText(text: string): string {
  if (!text) return "";
  
  // Remove Slack user mentions and replace with display names if possible
  let cleaned = text.replace(/<@([A-Z0-9]+)>/g, '@user');
  
  // Remove channel mentions
  cleaned = cleaned.replace(/<#([A-Z0-9]+)\|([^>]+)>/g, '#$2');
  cleaned = cleaned.replace(/<#([A-Z0-9]+)>/g, '#channel');
  
  // Clean up URLs
  cleaned = cleaned.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)');
  cleaned = cleaned.replace(/<(https?:\/\/[^>]+)>/g, '$1');
  
  // Remove formatting markers but keep the text
  cleaned = cleaned.replace(/```([^`]+)```/g, '$1');
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
  cleaned = cleaned.replace(/_([^_]+)_/g, '$1');
  cleaned = cleaned.replace(/~([^~]+)~/g, '$1');
  
  // Clean up emoji reactions (remove the ::)
  cleaned = cleaned.replace(/:([a-z0-9_+-]+):/g, '[$1]');
  
  // Decode HTML entities
  cleaned = cleaned.replace(/&gt;/g, '>');
  cleaned = cleaned.replace(/&lt;/g, '<');
  cleaned = cleaned.replace(/&amp;/g, '&');
  cleaned = cleaned.replace(/&quot;/g, '"');
  cleaned = cleaned.replace(/&#39;/g, "'");
  cleaned = cleaned.replace(/&nbsp;/g, ' ');
  
  // Trim excessive whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  return cleaned;
}

async function exportUserThreadsToFile(userId: string, outputPath: string): Promise<void> {
  try {
    // Get threads
    const threads = await getUserThreads(userId);
    
    if (threads.length === 0) {
      console.log(`⚠️ No threads found for user ${userId}`);
      return;
    }
    
    // Format threads
    const formattedContent = formatThreadsForExport(threads, userId);
    
    // Write to file
    const fullPath = path.resolve(outputPath);
    fs.writeFileSync(fullPath, formattedContent, 'utf-8');
    
    // Stats
    const totalMessages = threads.reduce((sum, t) => sum + t.messages.length, 0);
    const userMessages = threads.reduce((sum, t) => 
      sum + t.messages.filter(m => m.user_id === userId).length, 0
    );
    
    console.log(`
✅ Export Complete!
📁 Output File: ${fullPath}
📊 Statistics:
   - Total Threads: ${threads.length}
   - Total Messages: ${totalMessages}
   - User Messages: ${userMessages}
   - Other Messages: ${totalMessages - userMessages}
    `);
    
  } catch (error) {
    console.error("❌ Error exporting threads:", error);
    throw error;
  }
}

// Main execution
if (require.main === module) {
  console.log(`🚀 Starting thread export for user: ${TARGET_USER_ID}`);
  
  exportUserThreadsToFile(TARGET_USER_ID, OUTPUT_FILE)
    .then(() => {
      console.log("🏁 Export complete!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("💥 Export failed:", error);
      process.exit(1);
    });
}

export { getUserThreads, formatThreadsForExport, exportUserThreadsToFile };