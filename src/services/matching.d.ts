export interface Helper {
    id: string;
    name: string;
    skills: string[];
    score?: number;
}
export declare class HelperMatchingService {
    findHelpers(needText: string, requesterId?: string, limit?: number): Promise<Helper[]>;
    findHelpersForMultipleNeeds(needs: Array<{
        text: string;
        requesterId: string;
    }>): Promise<Map<string, Helper[]>>;
    private getWeekStart;
    getWeeklyStats(): Promise<{
        totalNeeds: number;
        totalHelpers: number;
        averageMatchScore: number;
        topSkills: Array<{
            skill: string;
            count: number;
        }>;
    }>;
}
export declare const helperMatchingService: HelperMatchingService;
//# sourceMappingURL=matching.d.ts.map