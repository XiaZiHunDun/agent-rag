import type {
  MemoryFacts,
  MemoryHit,
  MemoryKind,
  MemorySensitivity,
  ProjectLocator,
  TextMemoryStore,
} from "@agent-rag/core"
import { buildMemoryContext, type MemoryContextResult } from "@agent-rag/core"

/** Kinds that are injected even when they do not match the current goal. */
export const PINNED_USER_KINDS: readonly MemoryKind[] = ["profile", "preference", "commitment"]

export interface MemoryInjectionRequest {
  readonly ownerId: string
  readonly projectId?: string
  /** Current task goal; also used as the recall query. */
  readonly goal: string
  /** Changed / relevant file paths, appended to the recall query. */
  readonly files?: readonly string[]
  /** Character budget for the rendered block. */
  readonly maxChars?: number
  readonly includeSensitive?: boolean
  readonly pinnedLimit?: number
  readonly userLimit?: number
  readonly projectLimit?: number
  /** Evaluation clock; defaults to now. */
  readonly now?: string
}

export interface MemoryInjectionResult extends MemoryContextResult {
  readonly userHits: readonly MemoryHit[]
  readonly projectHits: readonly MemoryHit[]
}

function buildQuery(request: MemoryInjectionRequest): string {
  return [request.goal, ...(request.files ?? [])]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n")
}

/**
 * Collect user + project hits for a task and render the injectable block.
 *
 * User memory is always seeded with the pinned profile/preferences so a
 * personal assistant keeps a consistent persona even for unrelated tasks.
 */
export async function collectInjection(
  store: TextMemoryStore,
  request: MemoryInjectionRequest,
): Promise<MemoryInjectionResult> {
  const query = buildQuery(request)
  const includeSensitive = request.includeSensitive ?? false
  const now = request.now === undefined ? {} : { now: request.now }
  const userScope = { scope: "user" as const, ownerId: request.ownerId }

  const [pinned, userMatched, projectHits] = await Promise.all([
    store.search({
      scope: userScope,
      text: "",
      kinds: PINNED_USER_KINDS,
      limit: request.pinnedLimit ?? 3,
      includeSensitive,
      ...now,
    }),
    query
      ? store.search({
          scope: userScope,
          text: query,
          limit: request.userLimit ?? 6,
          includeSensitive,
          ...now,
        })
      : Promise.resolve([] as readonly MemoryHit[]),
    request.projectId
      ? store.search({
          scope: { scope: "project", ownerId: request.ownerId, projectId: request.projectId },
          text: query,
          limit: request.projectLimit ?? 8,
          includeSensitive,
          ...now,
        })
      : Promise.resolve([] as readonly MemoryHit[]),
  ])

  const seen = new Set(pinned.map((hit) => hit.record.id))
  const userHits = [...pinned, ...userMatched.filter((hit) => !seen.has(hit.record.id))]

  const context = buildMemoryContext({
    user: userHits,
    project: projectHits,
    ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
  })

  return { ...context, userHits, projectHits }
}

export type TaskMemoryStatus = "completed" | "failed" | "partial"

export interface MemoryItemInput {
  readonly kind: MemoryKind
  readonly title: string
  readonly text: string
  readonly tags?: readonly string[]
  readonly confidence?: number
  readonly sensitivity?: MemorySensitivity
}

export interface TaskReportInput {
  /** Use a projectId obtained from ProjectRegistry. */
  readonly projectId?: string
  /** Or let the server resolve it from a remote/path/name. */
  readonly project?: ProjectLocator
  readonly taskId: string
  readonly goal: string
  readonly summary: string
  readonly status: TaskMemoryStatus
  readonly changedFiles?: readonly string[]
  readonly tests?: {
    readonly command: string
    readonly passed: boolean
    readonly summary?: string
  }
  readonly items?: readonly MemoryItemInput[]
  /** Assistant name recorded in source.client, e.g. "dsh-wfxm". */
  readonly client?: string
  readonly occurredAt?: string
}

export interface SessionFactInput {
  readonly title: string
  readonly text: string
  readonly kind?: MemoryKind
  readonly tags?: readonly string[]
  readonly confidence?: number
  readonly sensitivity?: MemorySensitivity
}

export interface SessionProfileInput {
  readonly displayName?: string
  readonly communicationStyle?: string
  readonly preferences?: readonly string[]
  readonly commitments?: readonly string[]
  readonly relationships?: readonly {
    readonly name: string
    readonly relation: string
    readonly notes?: string
  }[]
}

export interface SessionReportInput {
  readonly sessionId: string
  readonly summary: string
  readonly profile?: SessionProfileInput
  readonly facts?: readonly SessionFactInput[]
  readonly client?: string
  readonly occurredAt?: string
}

export interface ReportResult {
  readonly projectId?: string
  readonly written: number
  readonly recordIds: readonly string[]
  readonly issues: readonly string[]
}

export interface RecallRequest {
  readonly ownerId?: string
  readonly projectId?: string
  readonly text: string
  readonly limit?: number
  readonly kinds?: readonly MemoryKind[]
  readonly tags?: readonly string[]
  readonly minConfidence?: number
  readonly includeSensitive?: boolean
  readonly includeExpired?: boolean
}

export interface RememberRequest {
  readonly ownerId?: string
  readonly scope?: "user" | "project"
  readonly projectId?: string
  readonly kind: MemoryKind
  readonly title: string
  readonly text: string
  readonly facts?: MemoryFacts
  readonly tags?: readonly string[]
  readonly confidence?: number
  readonly sensitivity?: MemorySensitivity
  readonly client?: string
  readonly validFrom?: string
  readonly validTo?: string
}
