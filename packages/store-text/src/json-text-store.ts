import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { MemoryValidationError, validateMemoryRecord } from "@agent-rag/core"
import type {
  MemoryHit,
  MemoryQuery,
  MemoryRecord,
  MemoryScopeRef,
  MemoryStoreStats,
  TextMemoryStore,
} from "@agent-rag/core"
import { InMemoryTextStore } from "./in-memory-text-store.ts"

interface SnapshotFile {
  readonly version: 1
  readonly records: readonly MemoryRecord[]
}

/**
 * JSON-file backed text store.
 *
 * The whole file is rewritten atomically on mutation. Suitable for single-user
 * local use and tests; a SQLite FTS5 / Postgres tsvector adapter should replace
 * it when concurrency or volume grows.
 */
export class JsonTextStore implements TextMemoryStore {
  private readonly filePath: string
  private readonly inner: InMemoryTextStore

  private constructor(filePath: string, inner: InMemoryTextStore) {
    this.filePath = filePath
    this.inner = inner
  }

  static async open(filePath: string): Promise<JsonTextStore> {
    const inner = new InMemoryTextStore()
    try {
      const raw = await readFile(filePath, "utf8")
      const parsed = JSON.parse(raw) as Partial<SnapshotFile>
      if (parsed.version !== 1) {
        throw new Error(`unsupported memory snapshot version: ${String(parsed.version)}`)
      }
      if (!Array.isArray(parsed.records)) {
        throw new Error("memory snapshot records must be an array")
      }
      for (const [index, item] of parsed.records.entries()) {
        const issues = validateMemoryRecord(item)
        if (issues.length > 0) {
          throw new MemoryValidationError(issues.map((issue) => `records[${index}]: ${issue}`))
        }
      }
      await inner.upsertMany(parsed.records)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") throw error
    }
    return new JsonTextStore(filePath, inner)
  }

  async upsert(record: MemoryRecord): Promise<void> {
    await this.inner.upsert(record)
    await this.commit()
  }

  async upsertMany(records: readonly MemoryRecord[]): Promise<void> {
    await this.inner.upsertMany(records)
    await this.commit()
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.inner.get(id)
  }

  async delete(id: string): Promise<void> {
    await this.inner.delete(id)
    await this.commit()
  }

  async deleteScope(scope: MemoryScopeRef): Promise<number> {
    const deleted = await this.inner.deleteScope(scope)
    if (deleted > 0) await this.commit()
    return deleted
  }

  async search(query: MemoryQuery): Promise<readonly MemoryHit[]> {
    return this.inner.search(query)
  }

  async stats(): Promise<MemoryStoreStats> {
    return this.inner.stats()
  }

  private async commit(): Promise<void> {
    const snapshot: SnapshotFile = { version: 1, records: this.inner.snapshot() }
    await mkdir(dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
    await rename(tempPath, this.filePath)
  }
}
