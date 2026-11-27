/**
 * Lightweight BM25 index over text + structured titles.
 *
 * Deliberately dependency-free: v1 stores text and structured JSON, and uses
 * this index in memory (or behind the JsonTextStore). A SQLite FTS5 / Postgres
 * tsvector adapter can implement the same TextMemoryStore contract later.
 */

const K1 = 1.2
const B = 0.75
const TITLE_WEIGHT = 3

export function tokenize(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase()
  const tokens: string[] = []
  for (const match of normalized.matchAll(/[a-z0-9_]+|[\u3400-\u9fff]+/g)) {
    const part = match[0]
    if (/^[a-z0-9_]+$/.test(part)) {
      tokens.push(part)
      continue
    }
    const chars = [...part]
    for (let index = 0; index < chars.length; index += 1) {
      tokens.push(chars[index] as string)
      const next = chars[index + 1]
      if (next) tokens.push(`${chars[index]}${next}`)
    }
  }
  return tokens
}

interface IndexedDoc {
  readonly terms: Map<string, number>
  readonly length: number
  readonly normalizedText: string
}

export interface TextSearchHit {
  readonly id: string
  readonly score: number
  readonly matchedTerms: readonly string[]
}

export class TextIndex {
  private readonly docs = new Map<string, IndexedDoc>()
  private readonly postings = new Map<string, Set<string>>()
  private totalLength = 0

  get size(): number {
    return this.docs.size
  }

  add(id: string, fields: { title: string; text: string; tags?: readonly string[] }): void {
    this.remove(id)
    const terms = new Map<string, number>()
    const addTokens = (text: string, weight: number): void => {
      for (const token of tokenize(text)) {
        terms.set(token, (terms.get(token) ?? 0) + weight)
      }
    }
    addTokens(fields.title, TITLE_WEIGHT)
    addTokens(fields.text, 1)
    for (const tag of fields.tags ?? []) addTokens(tag, 1)

    let length = 0
    for (const count of terms.values()) length += count
    const normalizedText = `${fields.title}\n${fields.text}\n${(fields.tags ?? []).join(" ")}`
      .normalize("NFKC")
      .toLowerCase()

    this.docs.set(id, { terms, length, normalizedText })
    this.totalLength += length
    for (const term of terms.keys()) {
      const bucket = this.postings.get(term) ?? new Set<string>()
      bucket.add(id)
      this.postings.set(term, bucket)
    }
  }

  remove(id: string): void {
    const existing = this.docs.get(id)
    if (!existing) return
    this.docs.delete(id)
    this.totalLength -= existing.length
    for (const term of existing.terms.keys()) {
      const bucket = this.postings.get(term)
      if (!bucket) continue
      bucket.delete(id)
      if (bucket.size === 0) this.postings.delete(term)
    }
  }

  search(queryText: string): readonly TextSearchHit[] {
    const normalizedQuery = queryText.normalize("NFKC").toLowerCase().trim()
    if (!normalizedQuery) return []
    const terms = [...new Set(tokenize(queryText))]
    if (terms.length === 0) return []

    const total = this.docs.size
    if (total === 0) return []
    const avgLength = this.totalLength / total
    const scores = new Map<string, number>()
    const matched = new Map<string, Set<string>>()

    for (const term of terms) {
      const bucket = this.postings.get(term)
      if (!bucket || bucket.size === 0) continue
      const df = bucket.size
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
      for (const id of bucket) {
        const doc = this.docs.get(id)
        if (!doc) continue
        const tf = doc.terms.get(term) ?? 0
        const denominator = tf + K1 * (1 - B + B * (doc.length / Math.max(avgLength, 1)))
        const score = idf * ((tf * (K1 + 1)) / Math.max(denominator, 1e-9))
        scores.set(id, (scores.get(id) ?? 0) + score)
        const set = matched.get(id) ?? new Set<string>()
        set.add(term)
        matched.set(id, set)
      }
    }

    // Exact phrase bonus keeps "端口配置" ahead of scattered single characters.
    if (normalizedQuery.length >= 2) {
      for (const [id, doc] of this.docs) {
        if (doc.normalizedText.includes(normalizedQuery)) {
          scores.set(id, (scores.get(id) ?? 0) + 5)
        }
      }
    }

    return [...scores.entries()]
      .map(([id, score]) => ({
        id,
        score,
        matchedTerms: [...(matched.get(id) ?? [])],
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  }
}
