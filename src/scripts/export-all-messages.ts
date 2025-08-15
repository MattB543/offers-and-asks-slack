import { config } from "dotenv";
import { db } from "../lib/database";
import * as fs from "fs";
import * as path from "path";

config();

const OUTPUT_FILE = "all-slack-messages-export.txt";

interface Message {
  channel_id: string;
  channel_name: string;
  ts: string;
  user_id: string;
  user_name: string;
  text: string;
  message_date: string;
  thread_ts: string | null;
  is_reply: boolean;
}

interface DayMessages {
  date: string;
  channels: {
    [channelName: string]: Message[];
  };
}

async function getAllMessages(): Promise<Message[]> {
  console.log('🔍 Fetching all messages (including threads) without subtype...');
  
  const messagesQuery = `
    SELECT 
      channel_id,
      channel_name,
      ts,
      user_id,
      user_name,
      text,
      thread_ts,
      is_reply,
      DATE(TO_TIMESTAMP(CAST(ts AS FLOAT))) as message_date
    FROM slack_message
    WHERE subtype IS NULL
      AND text IS NOT NULL
      AND text != ''
      AND user_name IS NOT NULL
    ORDER BY message_date ASC, channel_id, 
             CASE WHEN thread_ts IS NULL THEN ts ELSE thread_ts END ASC,
             CASE WHEN is_reply THEN 1 ELSE 0 END ASC,
             ts ASC
  `;
  
  const result = await db.query(messagesQuery);
  console.log(`📊 Found ${result.rows.length} messages (including threads)`);
  
  return result.rows as Message[];
}

function groupMessagesByDayAndChannel(messages: Message[]): DayMessages[] {
  const grouped: { [date: string]: { [channelName: string]: Message[] } } = {};
  
  for (const message of messages) {
    const date = message.message_date;
    const channelName = message.channel_name || 'unknown-channel';
    
    if (!grouped[date]) {
      grouped[date] = {};
    }
    
    if (!grouped[date][channelName]) {
      grouped[date][channelName] = [];
    }
    
    grouped[date][channelName].push(message);
  }
  
  // Convert to array and sort by date (oldest first)
  // Use proper date comparison instead of string comparison
  return Object.keys(grouped)
    .sort((a, b) => {
      const dateA = new Date(a);
      const dateB = new Date(b);
      return dateA.getTime() - dateB.getTime();
    })
    .map(date => ({
      date,
      channels: grouped[date]
    }));
}

function formatUserName(fullName: string): string {
  // Split by space and get first name + last initial
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0] || "Unknown";
  }
  
  const firstName = parts[0];
  const lastInitial = parts[parts.length - 1][0]; // Get first letter of last name
  
  return `${firstName} ${lastInitial}`;
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

function formatAllMessagesForExport(dayMessages: DayMessages[]): string {
  const lines: string[] = [];
  
  for (const day of dayMessages) {
    // Day header - format as simple date
    const dateObj = new Date(day.date);
    const formattedDate = dateObj.toLocaleDateString('en-US', { 
      weekday: 'short', 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
    lines.push(`===== ${formattedDate} =====`);
    lines.push("");
    
    // Sort channels alphabetically
    const channelNames = Object.keys(day.channels).sort();
    
    for (const channelName of channelNames) {
      const messages = day.channels[channelName];
      
      // Channel header
      lines.push(`--- #${channelName} ---`);
      
      // Messages in chronological order with thread indentation
      for (const msg of messages) {
        const userName = formatUserName(msg.user_name);
        const cleanText = cleanMessageText(msg.text);
        
        // Indent thread replies
        if (msg.is_reply && msg.thread_ts) {
          lines.push(`  └ ${userName}: ${cleanText}`);
        } else {
          lines.push(`${userName}: ${cleanText}`);
        }
      }
      
      lines.push(""); // Empty line after each channel
    }
    
    lines.push(""); // Extra empty line after each day
  }
  
  return lines.join('\n');
}

async function exportAllMessagesToFile(outputPath: string): Promise<void> {
  try {
    // Get all messages
    const messages = await getAllMessages();
    
    if (messages.length === 0) {
      console.log(`⚠️ No messages found`);
      return;
    }
    
    // Group by day and channel
    console.log('📊 Grouping messages by day and channel...');
    const dayMessages = groupMessagesByDayAndChannel(messages);
    
    // Format for export
    console.log('✨ Formatting messages for export...');
    const formattedContent = formatAllMessagesForExport(dayMessages);
    
    // Write to file
    const fullPath = path.resolve(outputPath);
    fs.writeFileSync(fullPath, formattedContent, 'utf-8');
    
    // Stats
    const totalDays = dayMessages.length;
    const totalChannels = new Set(messages.map(m => m.channel_name)).size;
    const totalMessages = messages.length;
    
    console.log(`
✅ Export Complete!
📁 Output File: ${fullPath}
📊 Statistics:
   - Total Days: ${totalDays}
   - Total Channels: ${totalChannels}
   - Total Messages: ${totalMessages}
    `);
    
  } catch (error) {
    console.error("❌ Error exporting messages:", error);
    throw error;
  }
}

// Main execution
if (require.main === module) {
  console.log(`🚀 Starting export of all Slack messages`);
  
  exportAllMessagesToFile(OUTPUT_FILE)
    .then(() => {
      console.log("🏁 Export complete!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("💥 Export failed:", error);
      process.exit(1);
    });
}

export { getAllMessages, groupMessagesByDayAndChannel, formatAllMessagesForExport, exportAllMessagesToFile };