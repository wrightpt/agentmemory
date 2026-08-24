import type { CompressedObservation } from "../types.js";
import { stem } from "./stemmer.js";
import { getSynonyms } from "./synonyms.js";
import { segmentCjk, hasCjk } from "./cjk-segmenter.js";

interface IndexEntry {
  sessionId: string;
  termCount: number;
  terms: string[];
}

export class SearchIndex {
  private entries: Map<string, IndexEntry> = new Map();
  private invertedIndex: Map<string, Map<string, number>> = new Map();
  private totalDocLength = 0;
  private sortedTerms: string[] | null = null;

  private readonly k1 = 1.2;
  private readonly b = 0.75;

  add(obs: CompressedObservation): void {
    if (this.entries.has(obs.id)) this.remove(obs.id);

    const terms = this.extractTerms(obs);
    const termFreq = new Map<string, number>();
    for (const term of terms) {
      termFreq.set(term, (termFreq.get(term) || 0) + 1);
    }

    this.entries.set(obs.id, {
      sessionId: obs.sessionId,
      termCount: terms.length,
      terms: Array.from(termFreq.keys()),
    });
    this.totalDocLength += terms.length;

    for (const [term, frequency] of termFreq) {
      let postings = this.invertedIndex.get(term);
      if (!postings) {
        postings = new Map();
        this.invertedIndex.set(term, postings);
      }
      postings.set(obs.id, frequency);
    }

    this.sortedTerms = null;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  getSessionId(id: string): string | undefined {
    return this.entries.get(id)?.sessionId;
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    for (const term of entry.terms) {
      const postings = this.invertedIndex.get(term);
      if (!postings) continue;
      postings.delete(id);
      if (postings.size === 0) this.invertedIndex.delete(term);
    }

    this.totalDocLength = Math.max(0, this.totalDocLength - entry.termCount);
    this.entries.delete(id);
    this.sortedTerms = null;
  }

  search(
    query: string,
    limit = 20,
  ): Array<{ obsId: string; sessionId: string; score: number }> {
    const rawTerms = this.tokenize(query.toLowerCase());
    if (rawTerms.length === 0) return [];

    const N = this.entries.size;
    if (N === 0) return [];
    const avgDocLen = this.totalDocLength / N;

    const queryTerms: Array<{ term: string; weight: number }> = [];
    const seen = new Set<string>();
    for (const term of rawTerms) {
      if (!seen.has(term)) {
        seen.add(term);
        queryTerms.push({ term, weight: 1.0 });
      }
      for (const syn of getSynonyms(term)) {
        if (!seen.has(syn)) {
          seen.add(syn);
          queryTerms.push({ term: syn, weight: 0.7 });
        }
      }
    }

    const scores = new Map<string, number>();
    const sorted = this.getSortedTerms();

    for (const { term, weight } of queryTerms) {
      const matchingDocs = this.invertedIndex.get(term);
      if (matchingDocs) {
        const df = matchingDocs.size;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

        for (const [obsId, tf] of matchingDocs) {
          const entry = this.entries.get(obsId)!;
          const docLen = entry.termCount;

          const numerator = tf * (this.k1 + 1);
          const denominator =
            tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
          const bm25Score = idf * (numerator / denominator) * weight;

          scores.set(obsId, (scores.get(obsId) || 0) + bm25Score);
        }
      }

      const startIdx = this.lowerBound(sorted, term);
      for (let si = startIdx; si < sorted.length; si++) {
        const indexTerm = sorted[si];
        if (!indexTerm.startsWith(term)) break;
        if (indexTerm === term) continue;

        const obsIds = this.invertedIndex.get(indexTerm)!;
        const prefixDf = obsIds.size;
        const prefixIdf =
          Math.log((N - prefixDf + 0.5) / (prefixDf + 0.5) + 1) * 0.5;
        for (const [obsId, tf] of obsIds) {
          const entry = this.entries.get(obsId)!;
          const docLen = entry.termCount;
          const numerator = tf * (this.k1 + 1);
          const denominator =
            tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
          scores.set(
            obsId,
            (scores.get(obsId) || 0) + prefixIdf * (numerator / denominator) * weight,
          );
        }
      }
    }

    return Array.from(scores.entries())
      .map(([obsId, score]) => {
        const entry = this.entries.get(obsId)!;
        return { obsId, sessionId: entry.sessionId, score };
      })
      .sort((a, b) => b.score - a.score || a.obsId.localeCompare(b.obsId))
      .slice(0, limit);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.invertedIndex.clear();
    this.totalDocLength = 0;
    this.sortedTerms = null;
  }

  restoreFrom(other: SearchIndex): void {
    this.entries = new Map(
      Array.from(other.entries.entries()).map(([id, entry]) => [
        id,
        { ...entry, terms: [...entry.terms] },
      ]),
    );
    this.invertedIndex = new Map(
      Array.from(other.invertedIndex.entries()).map(([term, postings]) => [
        term,
        new Map(postings),
      ]),
    );
    this.totalDocLength = other.totalDocLength;
    this.sortedTerms = null;
  }

  adoptFrom(other: SearchIndex): void {
    if (other === this) return;
    this.entries = other.entries;
    this.invertedIndex = other.invertedIndex;
    this.totalDocLength = other.totalDocLength;
    this.sortedTerms = other.sortedTerms;

    other.entries = new Map();
    other.invertedIndex = new Map();
    other.totalDocLength = 0;
    other.sortedTerms = null;
  }

  serialize(): string {
    // Term frequencies already live in postings. Persisting a second per-doc
    // map duplicated every doc/term pair and amplified heap use during restore.
    const entries = Array.from(this.entries, ([id, entry]) => [
      id,
      { sessionId: entry.sessionId, termCount: entry.termCount },
    ]);
    const inverted = Array.from(this.invertedIndex, ([term, postings]) => [
      term,
      Array.from(postings),
    ]);
    return JSON.stringify({
      v: 3,
      entries,
      inverted,
      totalDocLength: this.totalDocLength,
    });
  }

  static deserialize(json: string): SearchIndex {
    try {
      const idx = new SearchIndex();
      const data = JSON.parse(json);
      if (!Array.isArray(data?.entries) || !Array.isArray(data?.inverted)) {
        return idx;
      }

      for (const row of data.entries) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const [id, rawEntry] = row;
        const termCount = Number(rawEntry?.termCount);
        if (
          typeof id !== "string" ||
          typeof rawEntry?.sessionId !== "string" ||
          !Number.isInteger(termCount) ||
          termCount < 0
        ) {
          continue;
        }
        idx.entries.set(id, {
          sessionId: rawEntry.sessionId,
          termCount,
          terms: [],
        });
      }

      if (data.v === 3) {
        for (const row of data.inverted) {
          if (!Array.isArray(row) || row.length < 2) continue;
          const [term, rawPostings] = row;
          if (typeof term !== "string" || !Array.isArray(rawPostings)) continue;
          const postings = new Map<string, number>();
          for (const posting of rawPostings) {
            if (!Array.isArray(posting) || posting.length < 2) continue;
            const [id, rawFrequency] = posting;
            const frequency = Number(rawFrequency);
            const entry =
              typeof id === "string" ? idx.entries.get(id) : undefined;
            if (
              !entry ||
              !Number.isInteger(frequency) ||
              frequency <= 0 ||
              postings.has(id)
            ) {
              continue;
            }
            postings.set(id, frequency);
            entry.terms.push(term);
          }
          if (postings.size > 0) idx.invertedIndex.set(term, postings);
        }
      } else {
        if (!Array.isArray(data.docTerms)) return new SearchIndex();
        for (const row of data.docTerms) {
          if (!Array.isArray(row) || row.length < 2) continue;
          const [id, rawCounts] = row;
          const entry = typeof id === "string" ? idx.entries.get(id) : undefined;
          if (!entry || !Array.isArray(rawCounts)) continue;
          for (const count of rawCounts) {
            if (!Array.isArray(count) || count.length < 2) continue;
            const [term, rawFrequency] = count;
            const frequency = Number(rawFrequency);
            if (
              typeof term !== "string" ||
              !Number.isInteger(frequency) ||
              frequency <= 0
            ) {
              continue;
            }
            let postings = idx.invertedIndex.get(term);
            if (!postings) {
              postings = new Map();
              idx.invertedIndex.set(term, postings);
            }
            if (!postings.has(id)) entry.terms.push(term);
            postings.set(id, frequency);
          }
        }
      }

      const rawLength = Number(data.totalDocLength);
      idx.totalDocLength =
        Number.isFinite(rawLength) && rawLength >= 0
          ? Math.floor(rawLength)
          : Array.from(idx.entries.values()).reduce(
              (sum, entry) => sum + entry.termCount,
              0,
            );
      return idx;
    } catch {
      return new SearchIndex();
    }
  }

  private extractTerms(obs: CompressedObservation): string[] {
    const parts = [
      obs.title,
      obs.subtitle || "",
      obs.narrative,
      ...obs.facts,
      ...obs.concepts,
      ...obs.files,
      obs.type,
    ];
    return this.tokenize(parts.join(" ").toLowerCase());
  }

  private tokenize(text: string): string[] {
    const cleaned = text.replace(/[^\p{L}\p{N}\s/.\\-_]/gu, " ");
    const out: string[] = [];
    for (const raw of cleaned.split(/\s+/)) {
      if (raw.length < 2) continue;
      if (hasCjk(raw)) {
        for (const seg of segmentCjk(raw)) {
          if (seg.length >= 1) out.push(seg);
        }
      } else {
        out.push(stem(raw));
      }
    }
    return out;
  }

  private getSortedTerms(): string[] {
    if (!this.sortedTerms) {
      this.sortedTerms = Array.from(this.invertedIndex.keys()).sort();
    }
    return this.sortedTerms;
  }

  private lowerBound(arr: string[], target: string): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
