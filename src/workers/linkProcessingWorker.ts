import { linkProcessingService } from "../services/linkProcessingService";

/**
 * Enhanced background worker for processing pending links with metrics and optimization
 */
export class LinkProcessingWorker {
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly processIntervalMs: number;
  private readonly batchSize: number;
  
  // Enhanced metrics tracking
  private metrics = {
    totalProcessed: 0,
    successfullyProcessed: 0,
    failed: 0,
    averageProcessingTime: 0,
    lastProcessingTime: 0,
    startTime: Date.now(),
    lastBatchTime: Date.now()
  };

  constructor(options: {
    processIntervalMs?: number; // How often to check for pending links
    batchSize?: number; // How many links to process in each batch
  } = {}) {
    this.processIntervalMs = options.processIntervalMs || 30000; // 30 seconds default
    this.batchSize = options.batchSize || 3; // Process 3 links at a time to be respectful
  }

  /**
   * Start the background worker
   */
  start(): void {
    if (this.isRunning) {
      console.log("⚠️ Link processing worker is already running");
      return;
    }

    console.log(`🚀 Starting link processing worker (${this.processIntervalMs}ms intervals, batch size: ${this.batchSize})`);
    this.isRunning = true;

    // Process immediately on start
    this.processNextBatch().catch(error => {
      console.error("❌ Initial link processing batch failed:", error);
    });

    // Set up periodic processing
    this.intervalId = setInterval(() => {
      this.processNextBatch().catch(error => {
        console.error("❌ Link processing worker error:", error);
      });
    }, this.processIntervalMs);
  }

  /**
   * Stop the background worker
   */
  stop(): void {
    if (!this.isRunning) {
      console.log("⚠️ Link processing worker is not running");
      return;
    }

    console.log("🛑 Stopping link processing worker");
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Check if worker is running
   */
  isWorkerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Process the next batch of pending links with enhanced metrics
   */
  private async processNextBatch(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    const batchStartTime = Date.now();

    try {
      // Get current stats
      const stats = await linkProcessingService.getStats();
      
      if (stats.pending === 0) {
        // No work to do - only log occasionally to avoid spam
        if (Math.random() < 0.1) { // 10% chance to log
          console.log(`ℹ️ Link worker: ${stats.completed} completed, ${stats.failed} failed, 0 pending`);
          console.log(`📊 Worker metrics: ${this.metrics.totalProcessed} total, ${this.getSuccessRate()}% success rate, ${this.getProcessingRate()} links/hour`);
        }
        return;
      }

      console.log(`🔄 Link worker: Processing batch (${stats.pending} pending, ${stats.processing} processing)`);

      // Process a batch with timing
      const result = await linkProcessingService.processBatch(this.batchSize);

      // Update metrics
      this.updateMetrics(result, batchStartTime);

      if (result.processed > 0) {
        const processingTime = Date.now() - batchStartTime;
        console.log(`✅ Link worker: Processed ${result.processed} links in ${processingTime}ms (${result.successful} successful, ${result.failed} failed)`);
        
        // Log enhanced metrics every 10 successful batches
        if (this.metrics.totalProcessed > 0 && this.metrics.totalProcessed % 10 === 0) {
          this.logDetailedMetrics();
        }
      }

    } catch (error) {
      console.error("❌ Link worker batch processing failed:", error);
      this.metrics.failed++;
      
      // Adaptive interval on error - back off more aggressively
      if (this.isRunning && this.intervalId) {
        clearInterval(this.intervalId);
        const backoffMultiplier = Math.min(4, Math.floor(this.metrics.failed / 5) + 1);
        this.intervalId = setInterval(() => {
          this.processNextBatch().catch(error => {
            console.error("❌ Link processing worker error:", error);
          });
        }, this.processIntervalMs * backoffMultiplier);
      }
    }
  }

  /**
   * Update internal metrics after processing
   */
  private updateMetrics(result: { processed: number; successful: number; failed: number }, startTime: number): void {
    this.metrics.totalProcessed += result.processed;
    this.metrics.successfullyProcessed += result.successful;
    this.metrics.failed += result.failed;
    
    const processingTime = Date.now() - startTime;
    this.metrics.lastProcessingTime = processingTime;
    this.metrics.lastBatchTime = Date.now();
    
    // Update rolling average processing time
    if (result.processed > 0) {
      const avgTimePerLink = processingTime / result.processed;
      this.metrics.averageProcessingTime = 
        (this.metrics.averageProcessingTime * 0.9) + (avgTimePerLink * 0.1);
    }
  }

  /**
   * Calculate success rate percentage
   */
  private getSuccessRate(): number {
    if (this.metrics.totalProcessed === 0) return 0;
    return Math.round((this.metrics.successfullyProcessed / this.metrics.totalProcessed) * 100);
  }

  /**
   * Calculate processing rate in links per hour
   */
  private getProcessingRate(): number {
    const uptimeHours = (Date.now() - this.metrics.startTime) / (1000 * 60 * 60);
    if (uptimeHours < 0.1) return 0; // Avoid division by very small numbers
    return Math.round(this.metrics.totalProcessed / uptimeHours);
  }

  /**
   * Log detailed performance metrics
   */
  private logDetailedMetrics(): void {
    const uptimeMinutes = Math.round((Date.now() - this.metrics.startTime) / (1000 * 60));
    console.log(`📊 Link Worker Performance (${uptimeMinutes}m uptime):`);
    console.log(`   📈 Processed: ${this.metrics.totalProcessed} total (${this.metrics.successfullyProcessed} ✅, ${this.metrics.failed} ❌)`);
    console.log(`   ⚡ Rate: ${this.getProcessingRate()} links/hour, ${this.getSuccessRate()}% success`);
    console.log(`   ⏱️  Avg time: ${Math.round(this.metrics.averageProcessingTime)}ms/link`);
  }

  /**
   * Get current worker status with enhanced metrics
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    intervalMs: number;
    batchSize: number;
    metrics: {
      totalProcessed: number;
      successfullyProcessed: number;
      failed: number;
      successRate: number;
      processingRate: number;
      averageProcessingTime: number;
      uptime: number;
    };
    stats: {
      pending: number;
      processing: number;
      completed: number;
      failed: number;
    };
  }> {
    const stats = await linkProcessingService.getStats();
    
    return {
      isRunning: this.isRunning,
      intervalMs: this.processIntervalMs,
      batchSize: this.batchSize,
      metrics: {
        totalProcessed: this.metrics.totalProcessed,
        successfullyProcessed: this.metrics.successfullyProcessed,
        failed: this.metrics.failed,
        successRate: this.getSuccessRate(),
        processingRate: this.getProcessingRate(),
        averageProcessingTime: Math.round(this.metrics.averageProcessingTime),
        uptime: Date.now() - this.metrics.startTime
      },
      stats
    };
  }

  /**
   * Force process a specific number of links immediately (for debugging/admin)
   */
  async forceProcessBatch(batchSize?: number): Promise<{
    processed: number;
    successful: number;
    failed: number;
  }> {
    console.log(`🔧 Force processing batch of ${batchSize || this.batchSize} links...`);
    return await linkProcessingService.processBatch(batchSize || this.batchSize);
  }
}

// Export singleton instance
export const linkProcessingWorker = new LinkProcessingWorker();