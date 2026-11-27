import {
  MemoryValidationError,
  isExpired,
  recordMatchesScope,
  resolveLimit,
  scopeKey,
  validateMemoryRecord,
  validateScopeRef,
} from "@agent-rag/core"
import type {
  MemoryHit,
  MemoryQuery,
  MemoryRecord,
  MemoryScopeRef,
  MemoryStoreStats,
  TextMemoryStore,
} from "@agent-rag/core"
import { TextIndex } from "./text-index.ts"

/**
 * In-memory text store: canonical text + structured facts, BM25 retrieval,
 * strict scope isolation. This is the reference implementation for the
 * TextMemoryStore contract.
 */
export class InMemoryTextStore implements TextMemoryStore {
  private readonly records = new Map<string, MemoryRecord>()
  private readonly index = new TextIndex()

  async upsert(record: MemoryRecord): Promise<void> {
    this.upsertSync(record)
  }

  async upsertMany(records: readonly MemoryRecord[]): Promise<void> {
    for (const record of records) {
      const issues = validateMemoryRecord(record)
      if (issues.length > 0) throw new MemoryValidationError(issues)
    }
    for (const record of records) this.upsertSync(record)
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.records.get(id) ?? null
  }

  async delete(id: string): Promise<void> {
    this.deleteSync(id)
  }

  async deleteScope(scope: MemoryScopeRef): Promise<number> {
    const issues = validateScopeRef(scope)
    if (issues.length > 0) throw new Error(`invalid scope: ${issues.join("; ")}`)
    let deleted = 0
    for (const [id, record] of [...this.records]) {
      if (!recordMatchesScope(record, scope)) continue
      this.deleteSync(id)
      deleted += 1
    }
    return deleted
  }

  async search(query: MemoryQuery): Promise<readonly MemoryHit[]> {
    const issues = validateScopeRef(query.scope)
    if (issues.length > 0) throw new Error(`invalid scope: ${issues.join("; ")}`)
    const now = query.now ?? new Date().toISOString()
    const limit = resolveLimit(query.limit)
    const text = query.text.trim()

    const candidates: { record: MemoryRecord; score: number; matchedTerms: readonly string[] }[] = []
    if (text) {
      for (const hit of this.index.search(text)) {
        const record = this.records.get(hit.id)
        if (!record) continue
        candidates.push({ record, score: hit.score, matchedTerms: hit.matchedTerms })
      }
    } else {
      for (const record of this.records.values()) {
        candidates.push({ record, score: 0, matchedTerms: [] })
      }
    }

    const kinds = new Set(query.kinds ?? [])
    const tags = new Set(query.tags ?? [])
    const minConfidence = query.minConfidence ?? 0

    return candidates
      .filter(({ record }) => {
        if (!recordMatchesScope(record, query.scope)) return false
        if (!query.includeSensitive && record.sensitivity === "secret") return false
        if (!query.includeExpired && isExpired(record, now)) return false
        if (record.confidence < minConfidence) return false
        if (kinds.size > 0 && !kinds.has(record.kind)) return false
        if (tags.size > 0) {
          const recordTags = record.tags ?? []
          if (!recordTags.some((tag) => tags.has(tag))) return false
        }
        return true
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          Date.parse(b.record.updatedAt) - Date.parse(a.record.updatedAt) ||
          a.record.id.localeCompare(b.record.id),
      )
      .slice(0, limit)
  }

  async stats(): Promise<MemoryStoreStats> {
    const byScope: Record<string, number> = {}
    const byKind: Record<string, number> = {}
    for (const record of this.records.values()) {
      const key = scopeKey({
        scope: record.scope,
        ownerId: record.ownerId,
        ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
      })
      byScope[key] = (byScope[key] ?? 0) + 1
      byKind[record.kind] = (byKind[record.kind] ?? 0) + 1
    }
    return { total: this.records.size, byScope, byKind }
  }

  /** Snapshot for JSON persistence and replay tests. */
  snapshot(): readonly MemoryRecord[] {
    return [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  private upsertSync(record: MemoryRecord): void {
    const issues = validateMemoryRecord(record)
    if (issues.length > 0) throw new MemoryValidationError(issues)
    this.index.remove(record.id)
    this.records.set(record.id, record)
    this.index.add(record.id, {
      title: record.title,
      text: record.text,
      ...(record.tags === undefined ? {} : { tags: record.tags }),
    })
  }

  private deleteSync(id: string): void {
    if (!this.records.has(id)) return
    this.records.delete(id)
    this.index.remove(id)
  }
}
