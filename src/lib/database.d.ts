export declare class Database {
    private pool;
    constructor();
    query(text: string, params?: any[]): Promise<any>;
    initializeSchema(): Promise<void>;
    close(): Promise<void>;
    createPerson(slackId: string, displayName: string): Promise<void>;
    getPerson(slackId: string): Promise<any>;
    getAllEnabledPeople(): Promise<any[]>;
    togglePersonEnabled(slackId: string, enabled: boolean): Promise<void>;
    createSkill(skill: string): Promise<number>;
    updateSkillEmbedding(skillId: number, embedding: number[]): Promise<void>;
    getSkillByText(skill: string): Promise<any>;
    addPersonSkill(slackId: string, skillId: number): Promise<void>;
    removePersonSkill(slackId: string, skillId: number): Promise<void>;
    getPersonSkills(slackId: string): Promise<any[]>;
    createWeeklyNeed(slackId: string, needText: string, needEmbedding: number[], weekStart: string): Promise<number>;
    findSimilarHelpers(needEmbedding: number[], limit?: number): Promise<any[]>;
    healthCheck(): Promise<boolean>;
}
export declare const db: Database;
//# sourceMappingURL=database.d.ts.map