"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.embeddingService = exports.EmbeddingService = void 0;
const openai_1 = __importDefault(require("openai"));
class EmbeddingService {
    openai;
    constructor() {
        this.openai = new openai_1.default({
            apiKey: process.env.OPENAI_API_KEY,
        });
    }
    async generateEmbedding(text) {
        try {
            const response = await this.openai.embeddings.create({
                model: 'text-embedding-3-small',
                input: text,
            });
            return response.data[0].embedding;
        }
        catch (error) {
            console.error('Error generating embedding:', error);
            throw new Error(`Failed to generate embedding: ${error}`);
        }
    }
    async generateMultipleEmbeddings(texts) {
        try {
            const response = await this.openai.embeddings.create({
                model: 'text-embedding-3-small',
                input: texts,
            });
            return response.data.map(item => item.embedding);
        }
        catch (error) {
            console.error('Error generating multiple embeddings:', error);
            throw new Error(`Failed to generate embeddings: ${error}`);
        }
    }
    async healthCheck() {
        try {
            // Test with a simple embedding request
            await this.generateEmbedding('test');
            return true;
        }
        catch (error) {
            console.error('OpenAI health check failed:', error);
            return false;
        }
    }
}
exports.EmbeddingService = EmbeddingService;
exports.embeddingService = new EmbeddingService();
//# sourceMappingURL=openai.js.map