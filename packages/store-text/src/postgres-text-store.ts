import {
  MemoryValidationError,
  recordMatchesScope,
  resolveLimit,
  scopeKey,
  validateMemoryRecord,
  validateScopeRef,
} from "@agent-rag/core"
import type {
  MemoryFacts,
  MemoryHit,
  MemoryQuery,
  MemoryRecord,
  MemoryScopeRef,
  MemorySource,
  MemoryStoreStats,
  TextMemoryStore,
} from "@agent-rag/core"
import { tokenize } from "./text-index.ts"

/** Minimal SQL client contract; pg.Pool and PGlite both satisfy it. */
export interface SqlClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null; affectedRows?: number }>
}

interface MemoryRow {
  readonly id: string
  readonly schema_version: number
  readonly scope: string
  readonly owner_id: string
  readonly project_id: string
  readonly kind: string
  readonly title: string
  readonly text: string
  readonly facts: unknown
  readonly tags: unknown
  readonly source: unknown
  readonly confidence: number
  readonly sensitivity: string
  readonly valid_from: unknown
  readonly valid_to: unknown
  readonly created_at: unknown
  readonly updated_at: unknown
  readonly supersedes: unknown
  readonly checksum: string
}

const TABLE = "agent_rag_memory"

function iso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    schemaVersion: 1,
    scope: row.scope as MemoryRecord["scope"],
    ownerId: row.owner_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    kind: row.kind as MemoryRecord["kind"],
    title: row.title,
    text: row.text,
    facts: (row.facts ?? {}) as MemoryFacts,
    tags: (row.tags ?? []) as readonly string[],
    source: row.source as MemorySource,
    confidence: row.confidence,
    sensitivity: row.sensitivity as MemoryRecord["sensitivity"],
    ...(iso(row.valid_from) === undefined ? {} : { validFrom: iso(row.valid_from) }),
    ...(iso(row.valid_to) === undefined ? {} : { validTo: iso(row.valid_to) }),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
    supersedes: (row.supersedes ?? []) as readonly string[],
    checksum: row.checksum,
  }
}

function searchTextOf(record: MemoryRecord): { text: string; tokens: string } {
  const raw = `${record.title}\n${record.text}\n${(record.tags ?? []).join(" ")}`
  return { text: raw, tokens: [...new Set(tokenize(raw))].join(" ") }
}

function queryTokens(text: string): string {
  return [...new Set(tokenize(text))].join(" ")
}

/**
 * Postgres-backed text store.
 *
 * Records live in a regular table; a tokenized column is fed into `tsvector`
 * so Chinese bigrams and Latin words both work with the `simple` configuration.
 * The SQL client is injected, so WFXM can reuse its pool and tests can use PGlite.
 */
export class PostgresTextStore implements TextMemoryStore {
  private readonly client: SqlClient

  private constructor(client: SqlClient) {
    this.client = client
  }

  static async open(client: SqlClient): Promise<PostgresTextStore> {
    const store = new PostgresTextStore(client)
    await store.init()
    return store
  }

  async upsert(record: MemoryRecord): Promise<void> {
    const issues = validateMemoryRecord(record)
    if (issues.length > 0) throw new MemoryValidationError(issues)
    const search = searchTextOf(record)
    await this.client.query(
      `INSERT INTO ${TABLE} (
        id, schema_version, scope, owner_id, project_id, kind, title, text,
        facts, tags, source, confidence, sensitivity, valid_from, valid_to,
        created_at, updated_at, supersedes, checksum, search_text, search_vector
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,
        $16,$17,$18::jsonb,$19,$20,to_tsvector('simple',$20)
      )
      ON CONFLICT (id) DO UPDATE SET
        schema_version=EXCLUDED.schema_version,
        scope=EXCLUDED.scope,
        owner_id=EXCLUDED.owner_id,
        project_id=EXCLUDED.project_id,
        kind=EXCLUDED.kind,
        title=EXCLUDED.title,
        text=EXCLUDED.text,
        facts=EXCLUDED.facts,
        tags=EXCLUDED.tags,
        source=EXCLUDED.source,
        confidence=EXCLUDED.confidence,
        sensitivity=EXCLUDED.sensitivity,
        valid_from=EXCLUDED.valid_from,
        valid_to=EXCLUDED.valid_to,
        updated_at=EXCLUDED.updated_at,
        supersedes=EXCLUDED.supersedes,
        checksum=EXCLUDED.checksum,
        search_text=EXCLUDED.search_text,
        search_vector=EXCLUDED.search_vector`,
      [
        record.id,
        record.schemaVersion,
        record.scope,
        record.ownerId,
        record.projectId ?? "",
        record.kind,
        record.title,
        record.text,
        JSON.stringify(record.facts ?? {}),
        JSON.stringify(record.tags ?? []),
        JSON.stringify(record.source),
        record.confidence,
        record.sensitivity,
        record.validFrom ?? null,
        record.validTo ?? null,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record.supersedes ?? []),
        record.checksum ?? "",
        search.tokens,
      ],
    )
  }

  async upsertMany(records: readonly MemoryRecord[]): Promise<void> {
    for (const record of records) {
      const issues = validateMemoryRecord(record)
      if (issues.length > 0) throw new MemoryValidationError(issues)
    }
    for (const record of records) await this.upsert(record)
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const result = await this.client.query<MemoryRow>(
      `SELECT * FROM ${TABLE} WHERE id=$1 LIMIT 1`,
      [id],
    )
    const row = result.rows[0]
    return row ? rowToRecord(row) : null
  }

  async delete(id: string): Promise<void> {
    await this.client.query(`DELETE FROM ${TABLE} WHERE id=$1`, [id])
  }

  async deleteScope(scope: MemoryScopeRef): Promise<number> {
    const issues = validateScopeRef(scope)
    if (issues.length > 0) throw new Error(`invalid scope: ${issues.join("; ")}`)
    const result = await this.client.query(
      `DELETE FROM ${TABLE} WHERE scope=$1 AND owner_id=$2 AND project_id=$3`,
      [scope.scope, scope.ownerId, scope.projectId ?? ""],
    )
    return result.affectedRows ?? result.rowCount ?? 0
  }

  async search(query: MemoryQuery): Promise<readonly MemoryHit[]> {
    const issues = validateScopeRef(query.scope)
    if (issues.length > 0) throw new Error(`invalid scope: ${issues.join("; ")}`)
    const now = query.now ?? new Date().toISOString()
    const limit = resolveLimit(query.limit)
    const tokens = queryTokens(query.text)

    const where: string[] = ["scope=$1", "owner_id=$2", "project_id=$3"]
    const params: unknown[] = [query.scope.scope, query.scope.ownerId, query.scope.projectId ?? ""]
    let rank = "0::float8"

    if (tokens) {
      params.push(tokens)
      const index = params.length
      where.push(`search_vector @@ plainto_tsquery('simple', $${index})`)
      rank = `ts_rank_cd(search_vector, plainto_tsquery('simple', $${index}))`
    }
    if (!query.includeSensitive) where.push("sensitivity <> 'secret'")
    if (!query.includeExpired) {
      params.push(now)
      where.push(`(valid_to IS NULL OR valid_to > $${params.length}::timestamptz)`)
    }
    const minConfidence = query.minConfidence ?? 0
    if (minConfidence > 0) {
      params.push(minConfidence)
      where.push(`confidence >= $${params.length}`)
    }
    if (query.kinds && query.kinds.length > 0) {
      const placeholders = query.kinds.map((kind) => {
        params.push(kind)
        return `$${params.length}`
      })
      where.push(`kind IN (${placeholders.join(",")})`)
    }
    params.push(limit * 3)
    const limitIndex = params.length

    const result = await this.client.query<MemoryRow & { rank: number }>(
      `SELECT *, ${rank} AS rank FROM ${TABLE}
       WHERE ${where.join(" AND ")}
       ORDER BY rank DESC, updated_at DESC
       LIMIT $${limitIndex}`,
      params,
    )

    const tags = new Set(query.tags ?? [])
    return result.rows
      .map((row) => {
        const record = rowToRecord(row)
        return { record, score: Number(row.rank ?? 0), matchedTerms: [] as string[] }
      })
      .filter(({ record }) => {
        if (!recordMatchesScope(record, query.scope)) return false
        if (tags.size > 0) {
          const recordTags = record.tags ?? []
          if (!recordTags.some((tag) => tags.has(tag))) return false
        }
        return true
      })
      .slice(0, limit)
  }

  async listAll(): Promise<readonly MemoryRecord[]> {
    const result = await this.client.query<MemoryRow>(`SELECT * FROM ${TABLE} ORDER BY id`)
    return result.rows.map(rowToRecord)
  }

  async stats(): Promise<MemoryStoreStats> {
    const result = await this.client.query<{
      scope: string
      owner_id: string
      project_id: string
      kind: string
      source_client: string
      count: string | number
    }>(
      `SELECT scope, owner_id, project_id, kind,
              COALESCE(NULLIF(BTRIM(source->>'client'), ''), 'unknown') AS source_client,
              COUNT(*) AS count
       FROM ${TABLE}
       GROUP BY scope, owner_id, project_id, kind,
                COALESCE(NULLIF(BTRIM(source->>'client'), ''), 'unknown')`,
    )
    const byScope: Record<string, number> = {}
    const byKind: Record<string, number> = {}
    const bySource: Record<string, number> = {}
    let total = 0
    for (const row of result.rows) {
      const count = Number(row.count)
      total += count
      const key = scopeKey({
        scope: row.scope as MemoryRecord["scope"],
        ownerId: row.owner_id,
        ...(row.project_id ? { projectId: row.project_id } : {}),
      })
      byScope[key] = (byScope[key] ?? 0) + count
      byKind[row.kind] = (byKind[row.kind] ?? 0) + count
      bySource[row.source_client] = (bySource[row.source_client] ?? 0) + count
    }
    return { total, byScope, byKind, bySource }
  }

  private async init(): Promise<void> {
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        scope TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        facts JSONB NOT NULL DEFAULT '{}'::jsonb,
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        source JSONB NOT NULL,
        confidence DOUBLE PRECISION NOT NULL,
        sensitivity TEXT NOT NULL,
        valid_from TIMESTAMPTZ,
        valid_to TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        supersedes JSONB NOT NULL DEFAULT '[]'::jsonb,
        checksum TEXT NOT NULL,
        search_text TEXT NOT NULL,
        search_vector TSVECTOR NOT NULL
      )`,
    )
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_scope_idx
       ON ${TABLE} (scope, owner_id, project_id, updated_at DESC)`,
    )
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_fts_idx
       ON ${TABLE} USING GIN (search_vector)`,
    )
  }
}

export { searchTextOf }
