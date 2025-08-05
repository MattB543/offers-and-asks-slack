import { config } from 'dotenv';
config();

import { db } from '../lib/database';

async function setupDatabase() {
  console.log('🛠️  Setting up database...');
  
  try {
    await db.initializeSchema();
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