import { validateMemoryRecord, type MemoryRecord } from "@agent-rag/core"

/**
 * Serialize records as JSONL: one complete MemoryRecord per line.
 *
 * Records are expected to be sorted by the store (see `listAll`), so the same
 * data always produces the same bytes.
 */
export function serializeMemoryJsonl(records: readonly MemoryRecord[]): string {
  if (records.length === 0) return ""
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
}

/**
 * Parse a JSONL backup.
 *
 * Every non-blank line must be a complete, valid MemoryRecord. Errors carry the
 * original 1-based line number so the CLI can report `第 N 行: 原因`. Parsing
 * and validation happen before any write, which keeps imports all-or-nothing.
 */
export function parseMemoryJsonl(content: string): readonly MemoryRecord[] {
  const records: MemoryRecord[] = []
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/)

  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`第 ${index + 1} 行: ${reason}`)
    }

    const issues = validateMemoryRecord(parsed)
    if (issues.length > 0) {
      throw new Error(`第 ${index + 1} 行: ${issues.join("; ")}`)
    }
    records.push(parsed as MemoryRecord)
  }

  return records
}
