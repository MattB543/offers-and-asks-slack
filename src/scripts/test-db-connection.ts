import { db } from '../lib/database';

async function testConnection() {
  console.log('🔍 Testing database connection...');
  
  try {
    // Simple test query
    const result = await db.query('SELECT 1 as test');
    console.log('✅ Database connection successful!');
    console.log('📊 Test result:', result.rows[0]);
    
    // Check if documents table exists
    const tableCheck = await db.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('documents', 'document_embeddings')
    `);
    
    console.log('📋 Existing document tables:', tableCheck.rows.map((r: any) => r.table_name));
    
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    
    if (error instanceof Error) {
      console.error('Error details:', {
        message: error.message,
        code: (error as any).code,
        address: (error as any).address,
        port: (error as any).port
      });
    }
  }
}

testConnection();