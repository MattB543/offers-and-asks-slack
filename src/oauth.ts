import { InstallProvider } from '@slack/oauth';
import { config } from 'dotenv';

config();

// Create an OAuth installer
export const installer = new InstallProvider({
  clientId: process.env.SLACK_CLIENT_ID!,
  clientSecret: process.env.SLACK_CLIENT_SECRET!,
  stateSecret: process.env.SLACK_STATE_SECRET || 'my-state-secret-change-this',
  scopes: ['chat:write', 'im:write', 'users:read', 'channels:read', 'commands'],
  installationStore: {
    // Store installation data in your database
    storeInstallation: async (installation) => {
      // TODO: Store in database
      console.log('Installation stored for team:', installation.team?.id);
      // You'll need to create a table for workspace installations
      // Schema: workspace_id, bot_token, bot_id, team_name, etc.
      return;
    },
    fetchInstallation: async (installQuery) => {
      // TODO: Fetch from database
      console.log('Fetching installation for team:', installQuery.teamId);
      // Fetch the installation from your database
      throw new Error('Not implemented');
    },
    deleteInstallation: async (installQuery) => {
      // TODO: Delete from database
      console.log('Deleting installation for team:', installQuery.teamId);
      return;
    },
  },
});

// Express routes for OAuth
export const handleOAuthStart = async (req: any, res: any) => {
  try {
    const url = await installer.generateInstallUrl({
      scopes: ['chat:write', 'im:write', 'users:read', 'channels:read', 'commands'],
      redirectUri: `https://offers-and-asks-slack-nbgim.ondigitalocean.app/slack/oauth_redirect`
    });
    
    res.redirect(url);
  } catch (error) {
    console.error('Error generating install URL:', error);
    res.status(500).send('Error generating installation URL');
  }
};

export const handleOAuthRedirect = async (req: any, res: any) => {
  try {
    // Handle the OAuth callback
    await installer.handleCallback(req, res, {
      success: (installation, options, req, res) => {
        res.send('Success! The app has been installed to your workspace. You can close this window.');
      },
      failure: (error, options, req, res) => {
        res.send('Installation failed. Please try again or contact support.');
      },
    });
  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).send('Installation failed');
  }
};