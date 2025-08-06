import { WebAPICallResult } from '@slack/web-api';
import { InstallProvider, Installation, InstallationQuery, Logger } from '@slack/oauth';
import { db } from '../lib/database';

interface SlackOAuthResponse extends WebAPICallResult {
  access_token?: string;
  scope?: string;
  user_id?: string;
  team?: {
    id: string;
    name: string;
  };
  authed_user?: {
    id: string;
    access_token?: string;
  };
  bot_user_id?: string;
  app_id?: string;
  token_type?: string;
  expires_in?: number;
}

class OAuthService {
  private installer?: InstallProvider;
  private isConfigured: boolean = false;

  constructor() {
    if (!process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET) {
      console.warn('⚠️ OAuth credentials not found - OAuth features disabled');
      this.isConfigured = false;
      return;
    }

    this.isConfigured = true;
    this.installer = new InstallProvider({
      clientId: process.env.SLACK_CLIENT_ID,
      clientSecret: process.env.SLACK_CLIENT_SECRET,
      stateSecret: process.env.SLACK_STATE_SECRET || 'default-state-secret',
      installationStore: {
        storeInstallation: this.storeInstallation.bind(this),
        fetchInstallation: this.fetchInstallation.bind(this),
        deleteInstallation: this.deleteInstallation.bind(this),
      },
    });
  }

  private ensureConfigured(): void {
    if (!this.isConfigured) {
      throw new Error('OAuth not configured - missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET');
    }
  }

  /**
   * Generate OAuth install URL
   */
  generateInstallUrl(redirectUri?: string): string {
    this.ensureConfigured();
    const scopes = [
      'chat:write',
      'im:write', 
      'users:read',
      'channels:read',
      'commands'
    ];

    const baseUrl = 'https://slack.com/oauth/v2/authorize';
    const params = new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID!,
      scope: scopes.join(','),
      redirect_uri: redirectUri || `${process.env.BASE_URL}/slack/oauth_redirect`
    });

    return `${baseUrl}?${params.toString()}`;
  }

  /**
   * Handle OAuth callback
   */
  async handleCallback(code: string, state?: string): Promise<Installation> {
    this.ensureConfigured();
    
    // Use the web API directly instead of the callback handler
    const { WebClient } = await import('@slack/web-api');
    
    try {
      const client = new WebClient();
      const response = await client.oauth.v2.access({
        client_id: process.env.SLACK_CLIENT_ID!,
        client_secret: process.env.SLACK_CLIENT_SECRET!,
        code: code,
        ...(state && { state })
      });

      if (!response.ok) {
        throw new Error(`OAuth access failed: ${response.error}`);
      }

      const installation: Installation = {
        team: {
          id: response.team?.id!,
          name: response.team?.name,
        },
        enterprise: undefined,
        bot: {
          token: response.access_token!,
          userId: response.bot_user_id!,
          id: response.bot_user_id!,
          scopes: response.scope?.split(',') || [],
        },
        user: {
          token: undefined,
          refreshToken: undefined,
          expiresAt: undefined,
          scopes: undefined,
          id: '',
        },
      };

      // Add user if available
      if (response.authed_user?.access_token) {
        installation.user = {
          token: response.authed_user.access_token,
          refreshToken: undefined,
          expiresAt: undefined,
          scopes: undefined,
          id: response.authed_user.id!,
        };
      }

      // Store the installation using our custom store method
      await this.storeInstallation(installation);

      console.log('✅ OAuth installation successful:', {
        teamId: installation.team?.id,
        teamName: installation.team?.name,
        botUserId: installation.bot?.userId,
      });

      return installation;
    } catch (error) {
      console.error('❌ OAuth callback failed:', error);
      throw new Error(`OAuth callback failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Store installation in database
   */
  private async storeInstallation(installation: Installation): Promise<void> {
    try {
      const teamId = installation.team?.id;
      const botToken = installation.bot?.token;
      const botUserId = installation.bot?.userId;
      const userToken = installation.user?.token;
      const userId = installation.user?.id;

      if (!teamId || !botToken) {
        throw new Error('Missing required installation data');
      }

      await db.query(`
        INSERT INTO tenants (
          team_id, 
          team_name, 
          bot_token, 
          bot_user_id,
          user_token,
          user_id,
          scopes,
          installed_at,
          updated_at,
          active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), true)
        ON CONFLICT (team_id) 
        DO UPDATE SET 
          team_name = EXCLUDED.team_name,
          bot_token = EXCLUDED.bot_token,
          bot_user_id = EXCLUDED.bot_user_id,
          user_token = EXCLUDED.user_token,
          user_id = EXCLUDED.user_id,
          scopes = EXCLUDED.scopes,
          updated_at = NOW(),
          active = true
      `, [
        teamId,
        installation.team?.name || null,
        botToken,
        botUserId || null,
        userToken || null,
        userId || null,
        JSON.stringify(installation.bot?.scopes || [])
      ]);

      console.log(`📝 Stored installation for team: ${teamId}`);
    } catch (error) {
      console.error('❌ Failed to store installation:', error);
      throw error;
    }
  }

  /**
   * Fetch installation from database
   */
  private async fetchInstallation(query: InstallationQuery<boolean>, logger?: Logger): Promise<Installation> {
    try {
      let result;
      
      if (query.teamId) {
        result = await db.query(
          'SELECT * FROM tenants WHERE team_id = $1 AND active = true',
          [query.teamId]
        );
      } else if (query.userId) {
        result = await db.query(
          'SELECT * FROM tenants WHERE user_id = $1 AND active = true',
          [query.userId]
        );
      } else {
        throw new Error('Query must include teamId or userId');
      }

      if (result.rows.length === 0) {
        throw new Error('Installation not found');
      }

      const tenant = result.rows[0];
      
      const installation: Installation = {
        team: {
          id: tenant.team_id,
          name: tenant.team_name,
        },
        enterprise: undefined,
        bot: {
          token: tenant.bot_token,
          userId: tenant.bot_user_id,
          scopes: JSON.parse(tenant.scopes || '[]'),
          id: tenant.bot_user_id,
        },
        user: {
          token: undefined,
          refreshToken: undefined,
          expiresAt: undefined,
          scopes: undefined,
          id: '',
        },
      };

      // Add user if available
      if (tenant.user_token) {
        installation.user = {
          token: tenant.user_token,
          refreshToken: undefined,
          expiresAt: undefined,
          scopes: undefined,
          id: tenant.user_id,
        };
      }

      return installation;
    } catch (error) {
      console.error('❌ Failed to fetch installation:', error);
      throw error;
    }
  }

  /**
   * Delete installation from database
   */
  private async deleteInstallation(query: InstallationQuery<boolean>, logger?: Logger): Promise<void> {
    try {
      if (query.teamId) {
        await db.query(
          'UPDATE tenants SET active = false, updated_at = NOW() WHERE team_id = $1',
          [query.teamId]
        );
      } else if (query.userId) {
        await db.query(
          'UPDATE tenants SET active = false, updated_at = NOW() WHERE user_id = $1',
          [query.userId]
        );
      }
      
      console.log('🗑️ Marked installation as inactive');
    } catch (error) {
      console.error('❌ Failed to delete installation:', error);
      throw error;
    }
  }

  /**
   * Get bot token for a team
   */
  async getBotToken(teamId: string): Promise<string | null> {
    try {
      const result = await db.query(
        'SELECT bot_token FROM tenants WHERE team_id = $1 AND active = true',
        [teamId]
      );
      
      return result.rows[0]?.bot_token || null;
    } catch (error) {
      console.error('❌ Failed to get bot token:', error);
      return null;
    }
  }

  /**
   * List active installations
   */
  async listInstallations(): Promise<any[]> {
    try {
      const result = await db.query(
        'SELECT team_id, team_name, installed_at, updated_at FROM tenants WHERE active = true ORDER BY installed_at DESC'
      );
      
      return result.rows;
    } catch (error) {
      console.error('❌ Failed to list installations:', error);
      return [];
    }
  }

  getInstaller(): InstallProvider {
    this.ensureConfigured();
    return this.installer!;
  }
}

export const oauthService = new OAuthService();