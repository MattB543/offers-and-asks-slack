import { unifiedSearchService } from '../services/unifiedSearch';
import { hybridRetriever } from '../services/hybridRetriever';
import { keywordSearchService } from '../services/keywordSearch';

async function testHybridRetrieval() {
  console.log('🧪 Testing Hybrid Retrieval System\n');

  const testQueries = [
    // Implementation questions (should favor documents)
    {
      query: "How to implement AI for human reasoning",
      type: "Implementation Question",
      expectedSources: "Should favor documents"
    },
    
    // Discussion questions (should favor Slack)
    {
      query: "What did we discuss about epistemics yesterday",
      type: "Discussion Question", 
      expectedSources: "Should favor Slack messages"
    },
    
    // Broad topic (should include document summaries)
    {
      query: "Tell me about the AI fellowship retreat",
      type: "Broad Topic",
      expectedSources: "Should include document summaries"
    },
    
    // Technical terms (should find relevant code/docs)
    {
      query: "Database vector similarity search",
      type: "Technical Query",
      expectedSources: "Should find technical content"
    },
    
    // Temporal query (should favor recent Slack)
    {
      query: "Recent updates about the project",
      type: "Temporal Query", 
      expectedSources: "Should favor recent Slack messages"
    }
  ];

  for (const testCase of testQueries) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔍 Testing: "${testCase.query}"`);
    console.log(`📋 Type: ${testCase.type}`);
    console.log(`🎯 Expected: ${testCase.expectedSources}`);
    console.log(`${'='.repeat(60)}\n`);

    try {
      // Test 1: Legacy search
      console.log('🔄 Running Legacy Search...');
      const legacyResults = await unifiedSearchService.search(testCase.query, {
        limit: 5,
        useAdvancedRetrieval: false,
        rerank: true
      });
      
      console.log(`📊 Legacy Results (${legacyResults.length}):`);
      legacyResults.forEach((result, i) => {
        console.log(`  ${i + 1}. [${result.source}] ${result.content.substring(0, 100)}... (score: ${result.score.toFixed(3)})`);
      });

      // Test 2: Advanced hybrid retrieval
      console.log('\n🚀 Running Advanced Hybrid Retrieval...');
      const advancedResults = await unifiedSearchService.search(testCase.query, {
        limit: 5,
        useAdvancedRetrieval: true,
        enableRecencyBoost: true,
        enableContextExpansion: true
      });
      
      console.log(`📊 Advanced Results (${advancedResults.length}):`);
      advancedResults.forEach((result, i) => {
        console.log(`  ${i + 1}. [${result.source}] ${result.content.substring(0, 100)}... (score: ${result.score.toFixed(3)})`);
      });

      // Test 3: Keyword search comparison
      console.log('\n🔤 Running Keyword Search...');
      const keywordResults = await keywordSearchService.search(testCase.query, ['slack', 'document'], 5);
      
      console.log(`📊 Keyword Results (${keywordResults.length}):`);
      keywordResults.forEach((result, i) => {
        console.log(`  ${i + 1}. [${result.source}] ${result.content.substring(0, 100)}... (score: ${result.score.toFixed(3)})`);
      });

      // Analysis
      console.log('\n📈 Analysis:');
      const legacySourceCounts = countSources(legacyResults);
      const advancedSourceCounts = countSources(advancedResults);
      const keywordSourceCounts = countSources(keywordResults);
      
      console.log(`  Legacy:   Slack: ${legacySourceCounts.slack}, Docs: ${legacySourceCounts.document}`);
      console.log(`  Advanced: Slack: ${advancedSourceCounts.slack}, Docs: ${advancedSourceCounts.document}`);
      console.log(`  Keyword:  Slack: ${keywordSourceCounts.slack}, Docs: ${keywordSourceCounts.document}`);

    } catch (error) {
      console.error(`❌ Error testing "${testCase.query}":`, error);
    }

    // Pause between tests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\n✅ Hybrid Retrieval Testing Complete!');
}

function countSources(results: any[]): { slack: number; document: number } {
  return results.reduce((acc, result) => {
    acc[result.source]++;
    return acc;
  }, { slack: 0, document: 0 });
}

// Run the test
if (require.main === module) {
  testHybridRetrieval()
    .then(() => {
      console.log('\n🏁 All tests completed!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Test failed:', error);
      process.exit(1);
    });
}

export { testHybridRetrieval };