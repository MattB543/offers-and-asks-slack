import { SEARCH_CONFIG } from "../config/searchConfig";

export type RankedId = Array<[string, number]>;

export class HybridSearchService {
  reciprocalRankFusion(
    semanticResults: RankedId,
    keywordResults: RankedId,
    options?: { k?: number; semanticWeight?: number }
  ): RankedId {
    const k = options?.k ?? SEARCH_CONFIG.hybrid.rrfK;
    const semanticWeight =
      options?.semanticWeight ?? SEARCH_CONFIG.hybrid.semanticWeight;

    const rrfScores = new Map<string, number>();

    const add = (list: RankedId, weight: number) => {
      for (let rank = 0; rank < list.length; rank++) {
        const [docId] = list[rank];
        const addScore = weight / (k + rank + 1);
        rrfScores.set(docId, (rrfScores.get(docId) || 0) + addScore);
      }
    };

    add(semanticResults, semanticWeight);
    add(keywordResults, 1 - semanticWeight);

    const combined: RankedId = Array.from(rrfScores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => [id, score]);

    return combined;
  }
}

export const hybridSearchService = new HybridSearchService();
