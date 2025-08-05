# Distributing Offers and Asks Slack App

## Quick Setup for Distribution

### 1. Get OAuth Credentials
In your Slack app settings (https://api.slack.com/apps/YOUR_APP_ID):

1. Go to **Basic Information**
   - Copy your `Client ID`
   - Copy your `Client Secret`
   - Copy your `Signing Secret`

2. Go to **OAuth & Permissions**
   - Add OAuth Redirect URL:
     ```
     https://offers-and-asks-slack-nbgim.ondigitalocean.app/slack/oauth_redirect
     ```

### 2. Add Environment Variables
Add these to your DigitalOcean app:
```bash
SLACK_CLIENT_ID=your_client_id_here
SLACK_CLIENT_SECRET=your_client_secret_here
SLACK_STATE_SECRET=generate-a-random-string-here
```

### 3. Share Installation Link

#### Option A: Direct Slack Link (Simplest)
Share this link (replace YOUR_CLIENT_ID):
```
https://slack.com/oauth/v2/authorize?client_id=YOUR_CLIENT_ID&scope=chat:write,im:write,users:read,channels:read,commands&redirect_uri=https://offers-and-asks-slack-nbgim.ondigitalocean.app/slack/oauth_redirect
```

#### Option B: Add Install Button to Your Site
```html
<a href="https://slack.com/oauth/v2/authorize?client_id=YOUR_CLIENT_ID&scope=chat:write,im:write,users:read,channels:read,commands">
  <img alt="Add to Slack" height="40" width="139" 
       src="https://platform.slack-edge.com/img/add_to_slack.png" />
</a>
```

## For Single Workspace (Current Setup)

If you're only using this for one workspace, you don't need OAuth flow. Just:

1. Install to your workspace from the Slack app management page
2. Copy the `Bot User OAuth Token` (starts with `xoxb-`)
3. Set it as `SLACK_BOT_TOKEN` in your environment

## For Multiple Workspaces (Future)

To support multiple workspaces, you'll need to:

1. Implement the OAuth flow (code provided in `src/oauth.ts`)
2. Create a database table for workspace installations:
   ```sql
   CREATE TABLE workspace_installations (
     workspace_id VARCHAR(255) PRIMARY KEY,
     team_name VARCHAR(255),
     bot_token TEXT,
     bot_user_id VARCHAR(255),
     installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
     installed_by VARCHAR(255)
   );
   ```
3. Update the app to use workspace-specific tokens
4. Handle uninstalls via the `app_uninstalled` event

## Slack App Directory (Optional)

To list on the Slack App Directory:

1. Complete the app submission checklist
2. Add privacy policy URL
3. Add support email
4. Submit for review at: https://api.slack.com/apps/YOUR_APP_ID/distribute

## Testing Distribution

1. Create a test workspace at https://slack.com/create
2. Use your installation link to add the app
3. Verify all features work in the new workspace

## Security Notes

- Never commit OAuth credentials to git
- Rotate `SLACK_STATE_SECRET` regularly
- Store tokens encrypted in production
- Implement rate limiting on OAuth endpoints
- Log all installation/uninstallation events