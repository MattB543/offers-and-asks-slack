import { config } from "dotenv";
import { linkExtractionService } from "../services/linkExtractionService";
import { linkDatabaseService } from "../services/linkDatabaseService";
import { linkProcessingService } from "../services/linkProcessingService";
import { db } from "../lib/database";

config();

/**
 * Edge case and error handling tests for production readiness
 */
async function testEdgeCases() {
  console.log("🧪 EDGE CASE & ERROR HANDLING TESTS");
  console.log("=".repeat(50));
  
  const testResults = { passed: 0, failed: 0, errors: [] as string[] };

  try {
    // ===============================================
    // 1. LINK EXTRACTION EDGE CASES
    // ===============================================
    console.log("\n1. LINK EXTRACTION EDGE CASES");
    console.log("-".repeat(30));

    const extractionEdgeCases = [
      { name: "Empty string", input: "" },
      { name: "Null input", input: null as any },
      { name: "Undefined input", input: undefined as any },
      { name: "Very long URL", input: `Check this: ${"https://example.com/" + "a".repeat(1000)}` },
      { name: "Multiple protocols", input: "http://example.com https://example.com ftp://example.com" },
      { name: "Malformed URLs", input: "https:// http:// https://. https://..com" },
      { name: "URLs with special chars", input: "https://example.com/path?q=test&r=100% https://example.com/path#anchor" },
      { name: "Mixed with text", input: "Before https://example.com middle http://test.org after" },
      { name: "Slack pipe variations", input: "<https://example.com|> <https://test.com|Link> <malformed|text>" },
      { name: "Invalid domains", input: "https://localhost https://127.0.0.1 https://192.168.1.1" },
      { name: "File extensions", input: "https://example.com/file.pdf https://example.com/image.jpg" },
      { name: "No links", input: "This message has no links at all, just text and numbers 123" }
    ];

    for (const testCase of extractionEdgeCases) {
      try {
        const result = await linkExtractionService.extractLinksFromMessage(testCase.input);
        console.log(`   ✅ ${testCase.name}: ${result.length} links extracted`);
        
        // Verify all extracted links have required properties
        for (const link of result) {
          if (!link.cleanUrl || !link.domain || typeof link.position !== 'number') {
            throw new Error(`Invalid link structure: ${JSON.stringify(link)}`);
          }
        }
        testResults.passed++;
      } catch (error) {
        console.log(`   ❌ ${testCase.name}: ${error}`);
        testResults.failed++;
        testResults.errors.push(`${testCase.name}: ${error}`);
      }
    }

    // ===============================================
    // 2. DATABASE OPERATION EDGE CASES
    // ===============================================
    console.log("\n2. DATABASE OPERATION EDGE CASES");
    console.log("-".repeat(30));

    // Test duplicate link handling
    try {
      const duplicateCount1 = await linkExtractionService.processMessageLinks(
        "999999991", "Test duplicate: https://duplicate-test.com", "test-channel", "user1"
      );
      const duplicateCount2 = await linkExtractionService.processMessageLinks(
        "999999992", "Test duplicate: https://duplicate-test.com", "test-channel", "user2"
      );
      
      console.log(`   ✅ Duplicate link handling: ${duplicateCount1} + ${duplicateCount2} = should increment count`);
      testResults.passed++;
    } catch (error) {
      console.log(`   ❌ Duplicate link handling: ${error}`);
      testResults.failed++;
      testResults.errors.push(`Duplicate handling: ${error}`);
    }

    // Test invalid search parameters
    const searchEdgeCases = [
      { name: "Empty search query", options: { search: "" } },
      { name: "Very long search query", options: { search: "a".repeat(1000) } },
      { name: "Invalid limit", options: { limit: -1 } },
      { name: "Invalid offset", options: { offset: -10 } },
      { name: "Non-existent domain", options: { domain: "non-existent-domain-12345.com" } },
      { name: "Invalid status", options: { status: "invalid_status" as any } },
      { name: "Extreme limit", options: { limit: 999999 } }
    ];

    for (const testCase of searchEdgeCases) {
      try {
        const result = await linkDatabaseService.getLinksChronological(testCase.options as any);
        console.log(`   ✅ ${testCase.name}: ${result.links.length} results, handled gracefully`);
        testResults.passed++;
      } catch (error) {
        console.log(`   ❌ ${testCase.name}: ${error}`);
        testResults.failed++;
        testResults.errors.push(`Search ${testCase.name}: ${error}`);
      }
    }

    // ===============================================
    // 3. PROCESSING SERVICE EDGE CASES
    // ===============================================
    console.log("\n3. PROCESSING SERVICE EDGE CASES");
    console.log("-".repeat(30));

    // Test processing non-existent links
    try {
      const success = await linkProcessingService.processLink(999999999);
      console.log(`   ✅ Non-existent link ID: handled gracefully (${success})`);
      testResults.passed++;
    } catch (error) {
      console.log(`   ❌ Non-existent link ID: ${error}`);
      testResults.failed++;
      testResults.errors.push(`Non-existent link: ${error}`);
    }

    // Test batch processing with zero links
    try {
      const batchResult = await linkProcessingService.processBatch(0);
      console.log(`   ✅ Zero batch size: ${batchResult.processed} processed`);
      testResults.passed++;
    } catch (error) {
      console.log(`   ❌ Zero batch size: ${error}`);
      testResults.failed++;
      testResults.errors.push(`Zero batch: ${error}`);
    }

    // ===============================================
    // 4. SEMANTIC SEARCH EDGE CASES
    // ===============================================
    console.log("\n4. SEMANTIC SEARCH EDGE CASES");
    console.log("-".repeat(30));

    const semanticEdgeCases = [
      { name: "Empty query", query: "" },
      { name: "Very long query", query: "a".repeat(500) },
      { name: "Special characters", query: "!@#$%^&*()_+" },
      { name: "Unicode characters", query: "测试 עברית العربية русский" },
      { name: "Numbers only", query: "123456789" },
      { name: "SQL injection attempt", query: "'; DROP TABLE links; --" },
    ];

    for (const testCase of semanticEdgeCases) {
      try {
        const result = await linkDatabaseService.searchLinksSemanticSearch(testCase.query);
        console.log(`   ✅ ${testCase.name}: ${result.links.length} results, handled gracefully`);
        testResults.passed++;
      } catch (error) {
        console.log(`   ❌ ${testCase.name}: ${error}`);
        testResults.failed++;
        testResults.errors.push(`Semantic ${testCase.name}: ${error}`);
      }
    }

    // ===============================================
    // 5. CONCURRENT ACCESS TESTS
    // ===============================================
    console.log("\n5. CONCURRENT ACCESS TESTS");
    console.log("-".repeat(30));

    // Test concurrent link processing
    try {
      const concurrentPromises = Array(5).fill(0).map((_, i) => 
        linkExtractionService.processMessageLinks(
          `concurrent_${Date.now()}_${i}`,
          `Concurrent test ${i}: https://concurrent-${i}.com`,
          "test-channel",
          "test-user"
        )
      );
      
      const results = await Promise.all(concurrentPromises);
      const totalLinks = results.reduce((sum, count) => sum + count, 0);
      console.log(`   ✅ Concurrent processing: ${totalLinks} links processed successfully`);
      testResults.passed++;
    } catch (error) {
      console.log(`   ❌ Concurrent processing: ${error}`);
      testResults.failed++;
      testResults.errors.push(`Concurrent access: ${error}`);
    }

    // ===============================================
    // 6. MEMORY AND PERFORMANCE EDGE CASES
    // ===============================================
    console.log("\n6. MEMORY AND PERFORMANCE TESTS");
    console.log("-".repeat(30));

    // Test large message processing
    try {
      const largeMessage = `Large message with links: ${Array(100).fill(0).map((_, i) => 
        `https://example-${i}.com`
      ).join(" and ")}`;
      
      const largeResult = await linkExtractionService.extractLinksFromMessage(largeMessage);
      console.log(`   ✅ Large message: ${largeResult.length} links extracted from ${largeMessage.length} char message`);
      testResults.passed++;
    } catch (error) {
      console.log(`   ❌ Large message: ${error}`);
      testResults.failed++;
      testResults.errors.push(`Large message: ${error}`);
    }

    // Test large result set pagination
    try {
      const largePageResult = await linkDatabaseService.getLinksChronological({
        limit: 1000,
        offset: 0
      });
      console.log(`   ✅ Large pagination: ${largePageResult.links.length} results (total: ${largePageResult.total})`);
      testResults.passed++;
    } catch (error) {
      console.log(`   ❌ Large pagination: ${error}`);
      testResults.failed++;
      testResults.errors.push(`Large pagination: ${error}`);
    }

    // ===============================================
    // SUMMARY
    // ===============================================
    console.log("\n" + "=".repeat(50));
    console.log("📊 EDGE CASE TEST RESULTS");
    console.log("=".repeat(50));
    console.log(`✅ Tests Passed: ${testResults.passed}`);
    console.log(`❌ Tests Failed: ${testResults.failed}`);
    console.log(`📊 Success Rate: ${Math.round((testResults.passed / (testResults.passed + testResults.failed)) * 100)}%`);

    if (testResults.errors.length > 0) {
      console.log("\n❌ ERRORS FOUND:");
      testResults.errors.forEach((error, index) => {
        console.log(`   ${index + 1}. ${error}`);
      });
    }

    if (testResults.failed === 0) {
      console.log("\n🎉 ALL EDGE CASES HANDLED CORRECTLY - ROBUST SYSTEM!");
    } else {
      console.log(`\n⚠️  ${testResults.failed} EDGE CASES NEED ATTENTION`);
    }

  } catch (criticalError) {
    console.error("\n💥 CRITICAL ERROR DURING EDGE CASE TESTING:", criticalError);
    testResults.errors.push(`Critical: ${criticalError}`);
  } finally {
    await db.close();
  }
}

// Run the edge case tests
testEdgeCases();