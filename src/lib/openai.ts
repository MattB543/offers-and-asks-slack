import OpenAI from 'openai';

export class EmbeddingService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
      });

      return response.data[0].embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw new Error(`Failed to generate embedding: ${error}`);
    }
  }

  async generateMultipleEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: texts,
      });

      return response.data.map(item => item.embedding);
    } catch (error) {
      console.error('Error generating multiple embeddings:', error);
      throw new Error(`Failed to generate embeddings: ${error}`);
    }
  }

  async extractSkills(needText: string): Promise<string[]> {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are a technical skill analyzer. Given a request for help, extract 3-7 specific technical skills that would be needed to help this person. 

Return ONLY a JSON array of skill strings. Be specific and technical. Focus on concrete skills, technologies, and competencies rather than soft skills.

Examples:
- "I need help deploying my React app" → ["React.js", "deployment", "CI/CD", "web hosting"]
- "My database queries are slow" → ["SQL optimization", "database performance", "query analysis", "indexing"]
- "Setting up authentication" → ["authentication", "JWT", "OAuth", "security", "user management"]`
          },
          {
            role: 'user',
            content: needText
          }
        ],
        temperature: 0.3,
        max_tokens: 200
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) throw new Error('No response from GPT-4');

      const skills = JSON.parse(content);
      if (!Array.isArray(skills)) throw new Error('Response is not an array');

      return skills.filter(skill => typeof skill === 'string' && skill.length > 0);
    } catch (error) {
      console.error('Error extracting skills:', error);
      throw new Error(`Failed to extract skills: ${error}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    // A simple, no-cost check is to see if the API key is configured.
    const isConfigured = !!this.openai.apiKey;
    if (!isConfigured) {
        console.error('OpenAI health check failed: API key is missing.');
    }
    return isConfigured;
  }
}

export const embeddingService = new EmbeddingService();