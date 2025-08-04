import { config } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as csv from 'fast-csv';
import { db } from '../lib/database';
import { embeddingService } from '../lib/openai';

config();

interface SkillRow {
  skill: string;
  category?: string;
  description?: string;
}

class SkillSeeder {
  async seedFromCSV(csvFilePath: string): Promise<void> {
    console.log(`🌱 Starting skill seeding from ${csvFilePath}...`);

    if (!fs.existsSync(csvFilePath)) {
      throw new Error(`CSV file not found: ${csvFilePath}`);
    }

    const skills: SkillRow[] = [];

    // Read CSV file
    return new Promise((resolve, reject) => {
      fs.createReadStream(csvFilePath)
        .pipe(csv.parse({ headers: true, trim: true }))
        .on('data', (row: any) => {
          if (row.skill && row.skill.trim()) {
            skills.push({
              skill: row.skill.trim(),
              category: row.category?.trim(),
              description: row.description?.trim()
            });
          }
        })
        .on('end', async () => {
          try {
            await this.processSkills(skills);
            resolve();
          } catch (error) {
            reject(error);
          }
        })
        .on('error', reject);
    });
  }

  async seedFromArray(skillNames: string[]): Promise<void> {
    console.log(`🌱 Starting skill seeding from array of ${skillNames.length} skills...`);
    
    const skills: SkillRow[] = skillNames.map(skill => ({ skill: skill.trim() }));
    await this.processSkills(skills);
  }

  private async processSkills(skills: SkillRow[]): Promise<void> {
    console.log(`📝 Processing ${skills.length} skills...`);

    let createdCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Process skills in batches to avoid rate limiting
    const batchSize = 10;
    for (let i = 0; i < skills.length; i += batchSize) {
      const batch = skills.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(skills.length / batchSize)}...`);

      await Promise.all(batch.map(async (skillData) => {
        try {
          // Check if skill already exists
          const existingSkill = await db.getSkillByText(skillData.skill);
          if (existingSkill) {
            console.log(`⏭️  Skill "${skillData.skill}" already exists, skipping...`);
            skippedCount++;
            return;
          }

          // Create skill record
          const skillId = await db.createSkill(skillData.skill);
          
          // Generate embedding
          console.log(`🔮 Generating embedding for: ${skillData.skill}`);
          const embedding = await embeddingService.generateEmbedding(skillData.skill);
          
          // Update skill with embedding
          await db.updateSkillEmbedding(skillId, embedding);
          
          console.log(`✅ Added skill: ${skillData.skill} (ID: ${skillId})`);
          createdCount++;

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
          console.error(`❌ Error processing skill "${skillData.skill}":`, error);
          errorCount++;
        }
      }));

      // Longer delay between batches
      if (i + batchSize < skills.length) {
        console.log('⏳ Waiting between batches...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log(`\n📊 Skill seeding summary:`);
    console.log(`✅ Created: ${createdCount}`);
    console.log(`⏭️  Skipped: ${skippedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`📝 Total processed: ${skills.length}`);
  }

  async createSampleSkillsCSV(outputPath: string): Promise<void> {
    const sampleSkills = [
      { skill: 'JavaScript', category: 'Programming Languages', description: 'Dynamic programming language for web development' },
      { skill: 'TypeScript', category: 'Programming Languages', description: 'Typed superset of JavaScript' },
      { skill: 'React', category: 'Frontend Frameworks', description: 'JavaScript library for building user interfaces' },
      { skill: 'Node.js', category: 'Backend Technologies', description: 'JavaScript runtime for server-side development' },
      { skill: 'PostgreSQL', category: 'Databases', description: 'Open source relational database system' },
      { skill: 'Docker', category: 'DevOps', description: 'Containerization platform' },
      { skill: 'AWS', category: 'Cloud Platforms', description: 'Amazon Web Services cloud platform' },
      { skill: 'Git', category: 'Version Control', description: 'Distributed version control system' },
      { skill: 'Python', category: 'Programming Languages', description: 'High-level programming language' },
      { skill: 'Machine Learning', category: 'AI/ML', description: 'Algorithms that learn from data' },
      { skill: 'REST APIs', category: 'Web Services', description: 'Representational State Transfer web services' },
      { skill: 'GraphQL', category: 'Web Services', description: 'Query language for APIs' },
      { skill: 'CSS', category: 'Frontend Technologies', description: 'Cascading Style Sheets for styling' },
      { skill: 'HTML', category: 'Frontend Technologies', description: 'HyperText Markup Language' },
      { skill: 'Vue.js', category: 'Frontend Frameworks', description: 'Progressive JavaScript framework' },
      { skill: 'Angular', category: 'Frontend Frameworks', description: 'Platform for building mobile and desktop applications' },
      { skill: 'MongoDB', category: 'Databases', description: 'Document-oriented NoSQL database' },
      { skill: 'Redis', category: 'Databases', description: 'In-memory data structure store' },
      { skill: 'Kubernetes', category: 'DevOps', description: 'Container orchestration platform' },
      { skill: 'Terraform', category: 'Infrastructure as Code', description: 'Infrastructure provisioning tool' }
    ];

    const csvContent = 'skill,category,description\n' + 
      sampleSkills.map(s => `"${s.skill}","${s.category}","${s.description}"`).join('\n');

    fs.writeFileSync(outputPath, csvContent);
    console.log(`📄 Sample skills CSV created at: ${outputPath}`);
  }
}

// CLI interface
async function main() {
  const seeder = new SkillSeeder();

  try {
    // Initialize database connection
    await db.initializeSchema();
    console.log('📦 Database initialized');

    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
      case 'create-sample':
        const outputPath = args[1] || path.join(__dirname, '../../data/sample-skills.csv');
        await seeder.createSampleSkillsCSV(outputPath);
        break;

      case 'seed':
        const csvPath = args[1];
        if (!csvPath) {
          console.error('❌ Please provide a CSV file path');
          console.log('Usage: npm run seed-skills seed path/to/skills.csv');
          process.exit(1);
        }
        await seeder.seedFromCSV(csvPath);
        break;

      case 'seed-sample':
        // Seed with some common skills
        const commonSkills = [
          'JavaScript', 'TypeScript', 'React', 'Node.js', 'Python', 'PostgreSQL', 
          'Docker', 'AWS', 'Git', 'CSS', 'HTML', 'REST APIs', 'GraphQL',
          'Machine Learning', 'Data Analysis', 'SQL', 'MongoDB', 'Redis',
          'Kubernetes', 'DevOps', 'CI/CD', 'Testing', 'Vue.js', 'Angular',
          'Express.js', 'Django', 'Flask', 'Ruby on Rails', 'Java', 'C++',
          'Go', 'Rust', 'Swift', 'Kotlin', 'PHP', 'Laravel', 'Symfony',
          'Spring Boot', 'Microservices', 'System Design', 'Architecture',
          'Security', 'Performance Optimization', 'Code Review', 'Mentoring'
        ];
        await seeder.seedFromArray(commonSkills);
        break;

      default:
        console.log('Available commands:');
        console.log('  create-sample [output-path] - Create a sample skills CSV file');
        console.log('  seed <csv-path>             - Seed skills from CSV file');
        console.log('  seed-sample                 - Seed with common tech skills');
        break;
    }

    console.log('🎉 Seeding completed successfully');
    await db.close();
    process.exit(0);

  } catch (error) {
    console.error('❌ Seeding failed:', error);
    await db.close();
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export { SkillSeeder };