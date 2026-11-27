import type { MemoryKind, MemoryRecord } from "./memory-record.ts"
import type { MemoryScopeRef } from "./scope.ts"

export const DEFAULT_MEMORY_LIMIT = 10
export const MAX_MEMORY_LIMIT = 50

export interface MemoryQuery {
  readonly scope: MemoryScopeRef
  /** Free text; empty string means "recent records in scope". */
  readonly text: string
  readonly kinds?: readonly MemoryKind[]
  /** Any-of tag filter. */
  readonly tags?: readonly string[]
  readonly minConfidence?: number
  /** Include records whose validTo is in the past. Default false. */
  readonly includeExpired?: boolean
  /** Include sensitivity="secret" records. Default false. */
  readonly includeSensitive?: boolean
  /** Evaluation clock; defaults to now. */
  readonly now?: string
  readonly limit?: number
}

export interface MemoryHit {
  readonly record: MemoryRecord
  readonly score: number
  readonly matchedTerms: readonly string[]
}

export interface MemoryStoreStats {
  readonly total: number
  readonly byScope: Readonly<Record<string, number>>
}

/** Common contract implemented by text stores (in-memory, SQLite FTS, Postgres). */
export interface TextMemoryStore {
  upsert(record: MemoryRecord): Promise<void>
  upsertMany(records: readonly MemoryRecord[]): Promise<void>
  get(id: string): Promise<MemoryRecord | null>
  delete(id: string): Promise<void>
  /** Returns the number of deleted records. */
  deleteScope(scope: MemoryScopeRef): Promise<number>
  search(query: MemoryQuery): Promise<readonly MemoryHit[]>
  stats(): Promise<MemoryStoreStats>
}

export function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_MEMORY_LIMIT
  return Math.min(Math.floor(limit), MAX_MEMORY_LIMIT)
}

export function isExpired(record: MemoryRecord, now: string): boolean {
  if (!record.validTo) return false
  return Date.parse(record.validTo) <= Date.parse(now)
}
