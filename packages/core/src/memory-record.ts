import { createHash, randomUUID } from "node:crypto"

/** Bump when the persisted record shape changes in a breaking way. */
export const MEMORY_SCHEMA_VERSION = 1 as const
export type MemorySchemaVersion = typeof MEMORY_SCHEMA_VERSION

export type MemoryScope = "user" | "project"

export type MemoryKind =
  | "profile"
  | "preference"
  | "relationship"
  | "commitment"
  | "decision"
  | "convention"
  | "recipe"
  | "issue"
  | "task_summary"
  | "note"

/** Runtime list of every valid kind; keep in sync with `MemoryKind` above. */
export const MEMORY_KINDS = [
  "profile",
  "preference",
  "relationship",
  "commitment",
  "decision",
  "convention",
  "recipe",
  "issue",
  "task_summary",
  "note",
] as const satisfies readonly MemoryKind[]

export type MemorySensitivity = "normal" | "private" | "secret"

export type MemorySourceKind =
  | "butler_session"
  | "assistant_session"
  | "pi_session"
  | "task_result"
  | "manual"
  | "import"

export interface MemorySource {
  readonly kind: MemorySourceKind
  /** Session file, task id, message id, or other stable locator. */
  readonly ref: string
  /** Content hash / offset / revision of the source. */
  readonly version?: string
  /** Assistant that contributed the record, e.g. "wfxm" / "dsh-wfxm". */
  readonly client?: string
  /** Optional short excerpt for human review; not used as the canonical text. */
  readonly excerpt?: string
}

/** Primitive-only structured slots; keeps records JSON-safe. */
export type MemoryFactValue = string | number | boolean | null
export type MemoryFacts = Readonly<Record<string, MemoryFactValue>>

export interface MemoryRecord {
  readonly id: string
  readonly schemaVersion: MemorySchemaVersion
  readonly scope: MemoryScope
  /** User id for user scope; workspace/tenant owner id for project scope. */
  readonly ownerId: string
  /** Required when scope = "project"; forbidden when scope = "user". */
  readonly projectId?: string
  readonly kind: MemoryKind
  /** Short display title, also weighted higher during search. */
  readonly title: string
  /** Canonical searchable text. Must not be a raw transcript dump. */
  readonly text: string
  readonly facts?: MemoryFacts
  readonly tags?: readonly string[]
  readonly source: MemorySource
  /** 0..1; low-confidence records should not override explicit facts. */
  readonly confidence: number
  readonly sensitivity: MemorySensitivity
  readonly validFrom?: string
  readonly validTo?: string
  readonly createdAt: string
  readonly updatedAt: string
  /** IDs this record replaces; the store does not delete them automatically. */
  readonly supersedes?: readonly string[]
  /** Stable content hash of title + text + facts. */
  readonly checksum?: string
}

export interface MemoryRecordInput {
  readonly id?: string
  readonly scope: MemoryScope
  readonly ownerId: string
  readonly projectId?: string
  readonly kind: MemoryKind
  readonly title: string
  readonly text: string
  readonly facts?: MemoryFacts
  readonly tags?: readonly string[]
  readonly source: MemorySource
  readonly confidence?: number
  readonly sensitivity?: MemorySensitivity
  readonly validFrom?: string
  readonly validTo?: string
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly supersedes?: readonly string[]
}

export class MemoryValidationError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`invalid memory record: ${issues.join("; ")}`)
    this.name = "MemoryValidationError"
    this.issues = issues
  }
}

const SCOPES = new Set<MemoryScope>(["user", "project"])
const KINDS = new Set<MemoryKind>(MEMORY_KINDS)
const SENSITIVITIES = new Set<MemorySensitivity>(["normal", "private", "secret"])
const SOURCE_KINDS = new Set<MemorySourceKind>([
  "butler_session",
  "assistant_session",
  "pi_session",
  "task_result",
  "manual",
  "import",
])

const MAX_TITLE_LENGTH = 200
const MAX_TEXT_LENGTH = 20_000
const MAX_TAG_LENGTH = 64
const MAX_TAGS = 32

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Validate unknown JSON into a MemoryRecord; returns a list of issues. */
export function validateMemoryRecord(value: unknown): readonly string[] {
  const issues: string[] = []
  if (!isPlainObject(value)) return ["record must be an object"]

  if (value["schemaVersion"] !== MEMORY_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${MEMORY_SCHEMA_VERSION}`)
  }
  if (!isNonEmptyString(value["id"])) issues.push("id is required")
  if (!SCOPES.has(value["scope"] as MemoryScope)) issues.push("scope must be user or project")
  if (!isNonEmptyString(value["ownerId"])) issues.push("ownerId is required")

  const scope = value["scope"] as MemoryScope
  if (scope === "project" && !isNonEmptyString(value["projectId"])) {
    issues.push("projectId is required for project scope")
  }
  if (scope === "user" && value["projectId"] !== undefined) {
    issues.push("projectId must be omitted for user scope")
  }

  if (!KINDS.has(value["kind"] as MemoryKind)) issues.push("kind is invalid")

  const title = value["title"]
  if (!isNonEmptyString(title)) {
    issues.push("title is required")
  } else if (title.length > MAX_TITLE_LENGTH) {
    issues.push(`title must be <= ${MAX_TITLE_LENGTH} characters`)
  }

  const text = value["text"]
  if (!isNonEmptyString(text)) {
    issues.push("text is required")
  } else if (text.length > MAX_TEXT_LENGTH) {
    issues.push(`text must be <= ${MAX_TEXT_LENGTH} characters`)
  }

  const source = value["source"]
  if (!isPlainObject(source)) {
    issues.push("source is required")
  } else {
    if (!SOURCE_KINDS.has(source["kind"] as MemorySourceKind)) {
      issues.push("source.kind is invalid")
    }
    if (!isNonEmptyString(source["ref"])) issues.push("source.ref is required")
    if (source["version"] !== undefined && !isNonEmptyString(source["version"])) {
      issues.push("source.version must be a non-empty string")
    }
    if (source["excerpt"] !== undefined && typeof source["excerpt"] !== "string") {
      issues.push("source.excerpt must be a string")
    }
    if (source["client"] !== undefined) {
      if (!isNonEmptyString(source["client"]) || source["client"].length > MAX_TAG_LENGTH) {
        issues.push(`source.client must be a non-empty string <= ${MAX_TAG_LENGTH} characters`)
      }
    }
  }

  const confidence = value["confidence"]
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    issues.push("confidence must be a number")
  } else if (confidence < 0 || confidence > 1) {
    issues.push("confidence must be between 0 and 1")
  }

  if (!SENSITIVITIES.has(value["sensitivity"] as MemorySensitivity)) {
    issues.push("sensitivity is invalid")
  }

  if (value["facts"] !== undefined) {
    if (!isPlainObject(value["facts"])) {
      issues.push("facts must be an object")
    } else {
      for (const [key, fact] of Object.entries(value["facts"])) {
        if (!isNonEmptyString(key)) issues.push("facts keys must be non-empty")
        const type = typeof fact
        if (fact !== null && type !== "string" && type !== "number" && type !== "boolean") {
          issues.push(`fact ${key} must be string, number, boolean, or null`)
        }
      }
    }
  }

  if (value["tags"] !== undefined) {
    if (!Array.isArray(value["tags"])) {
      issues.push("tags must be an array")
    } else {
      if (value["tags"].length > MAX_TAGS) issues.push(`tags must have <= ${MAX_TAGS} items`)
      for (const tag of value["tags"]) {
        if (!isNonEmptyString(tag) || tag.length > MAX_TAG_LENGTH) {
          issues.push(`tag must be a non-empty string <= ${MAX_TAG_LENGTH} characters`)
        }
      }
    }
  }

  if (!isIsoDate(value["createdAt"])) issues.push("createdAt must be an ISO date")
  if (!isIsoDate(value["updatedAt"])) issues.push("updatedAt must be an ISO date")
  if (value["validFrom"] !== undefined && !isIsoDate(value["validFrom"])) {
    issues.push("validFrom must be an ISO date")
  }
  if (value["validTo"] !== undefined && !isIsoDate(value["validTo"])) {
    issues.push("validTo must be an ISO date")
  }
  if (isIsoDate(value["validFrom"]) && isIsoDate(value["validTo"])) {
    if (Date.parse(value["validTo"]) <= Date.parse(value["validFrom"])) {
      issues.push("validTo must be later than validFrom")
    }
  }

  if (value["supersedes"] !== undefined) {
    if (!Array.isArray(value["supersedes"])) {
      issues.push("supersedes must be an array")
    } else if (!value["supersedes"].every(isNonEmptyString)) {
      issues.push("supersedes items must be non-empty strings")
    }
  }

  if (value["checksum"] !== undefined && !isNonEmptyString(value["checksum"])) {
    issues.push("checksum must be a non-empty string")
  }

  return issues
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`
}

export function memoryChecksum(input: {
  readonly title: string
  readonly text: string
  readonly facts?: MemoryFacts
}): string {
  const payload = stableJson({ title: input.title, text: input.text, facts: input.facts ?? {} })
  return createHash("sha256").update(payload).digest("hex").slice(0, 32)
}

/**
 * Deterministic id for projected memory.
 *
 * Stable across re-projections: versioning the source must update the same
 * record instead of creating duplicates. Manual records can still pass an id.
 */
export function stableMemoryId(input: {
  readonly scope: MemoryScope
  readonly ownerId: string
  readonly projectId?: string
  readonly kind: MemoryKind
  readonly source: MemorySource
  readonly dedupeKey?: string
}): string {
  const key = input.dedupeKey ?? `${input.source.kind}:${input.source.ref}:${input.kind}`
  const payload = [input.scope, input.ownerId, input.projectId ?? "", key].join("\u0000")
  return createHash("sha256").update(payload).digest("hex").slice(0, 32)
}

/** Build a validated record, filling defaults and content checksum. */
export function createMemoryRecord(input: MemoryRecordInput): MemoryRecord {
  const now = new Date().toISOString()
  const createdAt = input.createdAt ?? now
  const record: MemoryRecord = {
    id: input.id ?? randomUUID(),
    schemaVersion: MEMORY_SCHEMA_VERSION,
    scope: input.scope,
    ownerId: input.ownerId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    kind: input.kind,
    title: input.title.trim(),
    text: input.text.trim(),
    ...(input.facts === undefined ? {} : { facts: input.facts }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    source: input.source,
    confidence: input.confidence ?? 0.8,
    sensitivity: input.sensitivity ?? "normal",
    ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
    ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
    checksum: memoryChecksum({ title: input.title.trim(), text: input.text.trim(), facts: input.facts }),
  }
  const issues = validateMemoryRecord(record)
  if (issues.length > 0) throw new MemoryValidationError(issues)
  return record
}
