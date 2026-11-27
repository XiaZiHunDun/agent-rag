import type { MemoryRecord, MemoryScope } from "./memory-record.ts"

export interface MemoryScopeRef {
  readonly scope: MemoryScope
  /** User id for user scope; workspace/tenant owner id for project scope. */
  readonly ownerId: string
  /** Required for project scope, forbidden for user scope. */
  readonly projectId?: string
}

export function validateScopeRef(ref: MemoryScopeRef): readonly string[] {
  const issues: string[] = []
  if (ref.scope !== "user" && ref.scope !== "project") {
    issues.push("scope must be user or project")
  }
  if (!ref.ownerId || ref.ownerId.trim().length === 0) issues.push("ownerId is required")
  if (ref.scope === "project" && (!ref.projectId || ref.projectId.trim().length === 0)) {
    issues.push("projectId is required for project scope")
  }
  if (ref.scope === "user" && ref.projectId !== undefined) {
    issues.push("projectId must be omitted for user scope")
  }
  return issues
}

export function scopeKey(ref: MemoryScopeRef): string {
  return [ref.scope, ref.ownerId, ref.projectId ?? ""].join("\u0000")
}

/** Strict match: no cross-scope and no cross-project reads. */
export function recordMatchesScope(record: MemoryRecord, ref: MemoryScopeRef): boolean {
  if (record.scope !== ref.scope) return false
  if (record.ownerId !== ref.ownerId) return false
  return (record.projectId ?? "") === (ref.projectId ?? "")
}

export function assertRecordInScope(record: MemoryRecord, ref: MemoryScopeRef): void {
  if (!recordMatchesScope(record, ref)) {
    throw new Error(`memory record ${record.id} is outside the requested scope`)
  }
}
