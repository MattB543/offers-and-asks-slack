import { config } from 'dotenv';
config();

import { db } from '../lib/database';
import { runLinksMigration } from './run-links-migration';

async function setupDatabase() {
  console.log('🛠️  Setting up database...');
  
  try {
    // Run main schema
    await db.initializeSchema();
    
    // Run links migration (don't close connection since we'll handle it)
    console.log('🔗 Setting up links tables...');
    await runLinksMigration(false);
    
    console.log('✅ Database setup completed successfully');
  } catch (error) {
    console.error('❌ Database setup failed:', error);
    throw error;
  } finally {
    await db.close();
  }
}

// Run if called directly
if (require.main === module) {
  setupDatabase()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export { setupDatabase };