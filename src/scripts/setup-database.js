"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupDatabase = setupDatabase;
const dotenv_1 = require("dotenv");
const database_1 = require("../lib/database");
(0, dotenv_1.config)();
async function setupDatabase() {
    console.log('🛠️  Setting up database...');
    try {
        await database_1.db.initializeSchema();
        console.log('✅ Database setup completed successfully');
    }
    catch (error) {
        console.error('❌ Database setup failed:', error);
        throw error;
    }
    finally {
        await database_1.db.close();
    }
}
// Run if called directly
if (require.main === module) {
    setupDatabase()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}
//# sourceMappingURL=setup-database.js.map