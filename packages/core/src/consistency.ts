import { MemoryValidationError, type MemoryRecord } from "./memory-record.ts"
import type { TextMemoryStore } from "./retrieval.ts"

export interface RetireSupersededOptions {
  readonly now?: string
}

/**
 * Marks records named in `record.supersedes` as no longer valid.
 *
 * The replacement record is expected to be written first; this only closes the
 * validity window of the old ones. Cross-scope supersedes are rejected so one
 * scope can never retire another scope's memory.
 */
export async function retireSupersededRecords(
  store: Pick<TextMemoryStore, "get" | "upsert">,
  record: MemoryRecord,
  options: RetireSupersededOptions = {},
): Promise<readonly string[]> {
  const targets = record.supersedes ?? []
  if (targets.length === 0) return []

  const now = options.now ?? record.createdAt
  const validTo = record.validFrom ?? now
  const retired: string[] = []

  for (const id of targets) {
    if (id === record.id) continue
    const previous = await store.get(id)
    if (!previous) continue
    if (
      previous.scope !== record.scope ||
      previous.ownerId !== record.ownerId ||
      previous.projectId !== record.projectId
    ) {
      throw new MemoryValidationError([
        `superseded record ${id} is outside scope ${record.scope}/${record.ownerId}`,
      ])
    }
    // Already retired, or never valid before the replacement.
    if (previous.validFrom !== undefined && previous.validFrom >= validTo) continue
    if (previous.validTo !== undefined && previous.validTo <= validTo) continue

    await store.upsert({ ...previous, validTo, updatedAt: now })
    retired.push(id)
  }

  return retired
}
