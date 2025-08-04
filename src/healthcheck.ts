import { config } from 'dotenv';
import { db } from './lib/database';

config();

async function healthCheck() {
  try {
    // Check database connection
    const dbHealthy = await db.healthCheck();
    if (!dbHealthy) {
      console.error('Database health check failed');
      process.exit(1);
    }
    
    console.log('Health check passed');
    process.exit(0);
  } catch (error) {
    console.error('Health check failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  healthCheck();
}

export { healthCheck };