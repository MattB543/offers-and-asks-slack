import { WebClient } from '@slack/web-api';
import { db } from '../lib/database';

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
}

export class UserService {
  private client: WebClient;

  constructor(client: WebClient) {
    this.client = client;
  }

  async fetchAllUsers(): Promise<SlackUser[]> {
    const users: SlackUser[] = [];
    let cursor: string | undefined;
    
    try {
      do {
        const response = await this.client.users.list({
          cursor,
          limit: 200
        });
        
        if (response.members) {
          users.push(...response.members.filter(user => 
            !user.is_bot && 
            !user.is_app_user && 
            !user.deleted &&
            user.id !== 'USLACKBOT'
          ) as SlackUser[]);
        }
        
        cursor = response.response_metadata?.next_cursor;
      } while (cursor);
      
      console.log(`✅ Fetched ${users.length} human users from workspace`);
      return users;
    } catch (error) {
      console.error('❌ Error fetching users:', error);
      throw error;
    }
  }

  async syncUsersToDatabase(): Promise<{ added: number; updated: number }> {
    const users = await this.fetchAllUsers();
    let added = 0;
    let updated = 0;
    
    for (const user of users) {
      const displayName = user.real_name || user.name || 'Unknown';
      
      try {
        const existingUser = await db.getPerson(user.id);
        
        if (!existingUser) {
          await db.createPerson(user.id, displayName);
          added++;
          console.log(`➕ Added user: ${displayName} (${user.id})`);
        } else if (existingUser.display_name !== displayName) {
          await db.createPerson(user.id, displayName);
          updated++;
          console.log(`🔄 Updated user: ${displayName} (${user.id})`);
        }
      } catch (error) {
        console.error(`❌ Error syncing user ${user.id}:`, error);
      }
    }
    
    console.log(`✅ Sync complete: ${added} added, ${updated} updated`);
    return { added, updated };
  }

  formatUserList(users: SlackUser[]): string {
    return users
      .map((user, index) => {
        const realName = user.real_name || 'N/A';
        const displayName = user.name || 'N/A';
        return `${index + 1}. *${realName}* (${displayName}) - \`${user.id}\``;
      })
      .join('\n');
  }
}