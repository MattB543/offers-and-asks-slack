"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthCheck = healthCheck;
const dotenv_1 = require("dotenv");
const database_1 = require("./lib/database");
(0, dotenv_1.config)();
async function healthCheck() {
    try {
        // Check database connection
        const dbHealthy = await database_1.db.healthCheck();
        if (!dbHealthy) {
            console.error('Database health check failed');
            process.exit(1);
        }
        console.log('Health check passed');
        process.exit(0);
    }
    catch (error) {
        console.error('Health check failed:', error);
        process.exit(1);
    }
}
// Run if called directly
if (require.main === module) {
    healthCheck();
}
//# sourceMappingURL=healthcheck.js.map