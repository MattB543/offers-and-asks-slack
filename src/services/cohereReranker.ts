export class CohereReranker {
  private apiKey = process.env.COHERE_API_KEY;
  private apiUrl = "https://api.cohere.com/v2/rerank";

  async rerank(
    query: string,
    messages: any[],
    topK: number = 20
  ): Promise<Array<{ index: number; score: number }>> {
    if (!this.apiKey || messages.length === 0) {
      return messages.map((_, i) => ({ index: i, score: 0 }));
    }

    try {
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "X-Client-Name": "slack-search",
        },
        body: JSON.stringify({
          model: "rerank-v3.5", // Latest multilingual model
          query: query,
          top_n: topK,
          documents: messages.map(
            (msg) =>
              `Message: ${msg.text}\nFrom: ${
                msg.author || msg.user_id
              }\nChannel: #${msg.channel_name}`
          ),
        }),
      });

      if (!response.ok) {
        console.error("Cohere rerank failed:", response.statusText);
        return messages.map((_, i) => ({ index: i, score: 0 }));
      }

      const data = await response.json();
      return data.results.map((r: any) => ({
        index: r.index,
        score: r.relevance_score,
      }));
    } catch (error) {
      console.error("Rerank error:", error);
      return messages.map((_, i) => ({ index: i, score: 0 }));
    }
  }
}

export const cohereReranker = new CohereReranker();
