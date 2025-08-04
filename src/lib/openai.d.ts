export declare class EmbeddingService {
    private openai;
    constructor();
    generateEmbedding(text: string): Promise<number[]>;
    generateMultipleEmbeddings(texts: string[]): Promise<number[][]>;
    healthCheck(): Promise<boolean>;
}
export declare const embeddingService: EmbeddingService;
//# sourceMappingURL=openai.d.ts.map