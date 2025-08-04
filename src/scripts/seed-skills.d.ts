declare class SkillSeeder {
    seedFromCSV(csvFilePath: string): Promise<void>;
    seedFromArray(skillNames: string[]): Promise<void>;
    private processSkills;
    createSampleSkillsCSV(outputPath: string): Promise<void>;
}
export { SkillSeeder };
//# sourceMappingURL=seed-skills.d.ts.map