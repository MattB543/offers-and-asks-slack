-- Create tenants table for multi-workspace OAuth support
CREATE TABLE IF NOT EXISTS tenants (
    id SERIAL PRIMARY KEY,
    team_id VARCHAR(20) UNIQUE NOT NULL,
    team_name VARCHAR(255),
    bot_token TEXT NOT NULL,
    bot_user_id VARCHAR(20),
    user_token TEXT,
    user_id VARCHAR(20),
    scopes JSONB DEFAULT '[]'::jsonb,
    installed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    active BOOLEAN DEFAULT true,
    
    -- Indexes for performance
    CONSTRAINT unique_active_team UNIQUE (team_id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_tenants_team_id ON tenants(team_id);
CREATE INDEX IF NOT EXISTS idx_tenants_active ON tenants(active);
CREATE INDEX IF NOT EXISTS idx_tenants_installed_at ON tenants(installed_at);

-- Add a trigger to automatically update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_tenants_updated_at ON tenants;
CREATE TRIGGER update_tenants_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();