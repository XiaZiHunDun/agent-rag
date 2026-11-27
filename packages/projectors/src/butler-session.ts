import {
  createMemoryRecord,
  stableMemoryId,
  type MemoryKind,
  type MemoryRecord,
  type MemorySensitivity,
  type ProjectionContext,
  type ProjectionEvent,
  type Projector,
} from "@agent-rag/core"

export interface ButlerFactInput {
  readonly title: string
  readonly text: string
  readonly kind?: MemoryKind
  readonly tags?: readonly string[]
  readonly confidence?: number
  readonly sensitivity?: MemorySensitivity
}

export interface ButlerProfileInput {
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

/** Structured output of a butler session summary; never a raw transcript. */
export interface ButlerSessionSummaryPayload {
  readonly userId: string
  readonly sessionId: string
  readonly summary: string
  readonly profile?: ButlerProfileInput
  readonly facts?: readonly ButlerFactInput[]
}

function bullet(label: string, items: readonly string[] | undefined): string {
  if (!items || items.length === 0) return ""
  return `${label}：${items.join("；")}\n`
}

function profileText(payload: ButlerSessionSummaryPayload): string {
  const profile = payload.profile ?? {}
  const relationships = profile.relationships?.map(
    (item) => `${item.name}（${item.relation}${item.notes ? `，${item.notes}` : ""}）`,
  )
  return [
    payload.summary.trim() ? `会话摘要：${payload.summary.trim()}\n` : "",
    profile.communicationStyle ? `沟通风格：${profile.communicationStyle}\n` : "",
    bullet("偏好", profile.preferences),
    bullet("长期承诺", profile.commitments),
    bullet("关系", relationships),
  ]
    .join("")
    .trim()
}

function profileFacts(payload: ButlerSessionSummaryPayload): Record<string, string | number> {
  const facts: Record<string, string | number> = {}
  const profile = payload.profile ?? {}
  if (profile.displayName) facts["displayName"] = profile.displayName
  if (profile.communicationStyle) facts["communicationStyle"] = profile.communicationStyle
  if (profile.preferences && profile.preferences.length > 0) {
    facts["preferences"] = profile.preferences.join("; ")
  }
  if (profile.commitments && profile.commitments.length > 0) {
    facts["commitments"] = profile.commitments.join("; ")
  }
  if (profile.relationships && profile.relationships.length > 0) {
    facts["relationships"] = profile.relationships
      .map((item) => `${item.name}:${item.relation}`)
      .join("; ")
  }
  return facts
}

/**
 * Projects a summarized assistant session into user-scope memory.
 *
 * Supports both WFXM's butler session events and the generic
 * assistant_session source used by other clients; the dedupe keys are shared,
 * so switching assistants updates the same profile instead of duplicating it.
 */
export class ButlerSessionProjector implements Projector {
  readonly name = "butler-session"
  readonly sourceKind = "butler_session" as const

  supports(event: ProjectionEvent): boolean {
    if (event.source.kind !== "butler_session" && event.source.kind !== "assistant_session") {
      return false
    }
    return (
      event.type === "butler.session.summarized" ||
      event.type === "butler.session.completed" ||
      event.type === "assistant.session.summarized" ||
      event.type === "assistant.session.completed"
    )
  }

  project(event: ProjectionEvent, context: ProjectionContext): readonly MemoryRecord[] {
    if (context.scope.scope !== "user") {
      throw new Error("butler session projector requires a user-scope context")
    }
    const payload = event.payload as ButlerSessionSummaryPayload
    if (!payload || typeof payload !== "object") throw new Error("payload is required")
    if (!payload.userId) throw new Error("payload.userId is required")
    if (payload.userId !== context.scope.ownerId) {
      throw new Error("payload.userId does not match the projection scope")
    }
    if (!payload.sessionId) throw new Error("payload.sessionId is required")

    const records: MemoryRecord[] = []
    const text = profileText(payload)
    if (text) {
      const title = payload.profile?.displayName
        ? `${payload.profile.displayName} 的用户画像`
        : "用户画像"
      records.push(
        createMemoryRecord({
          id: stableMemoryId({
            scope: "user",
            ownerId: payload.userId,
            kind: "profile",
            source: { kind: event.source.kind, ref: payload.sessionId },
            dedupeKey: "user-profile",
          }),
          scope: "user",
          ownerId: payload.userId,
          kind: "profile",
          title,
          text,
          facts: profileFacts(payload),
          tags: ["profile", "butler"],
          source: {
            kind: event.source.kind,
            ref: payload.sessionId,
            version: event.occurredAt,
            ...(event.source.client === undefined ? {} : { client: event.source.client }),
          },
          confidence: 0.9,
          sensitivity: "normal",
          validFrom: event.occurredAt,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        }),
      )
    }

    for (const [index, fact] of (payload.facts ?? []).entries()) {
      if (!fact.title || !fact.text) continue
      const kind = fact.kind ?? "note"
      records.push(
        createMemoryRecord({
          id: stableMemoryId({
            scope: "user",
            ownerId: payload.userId,
            kind,
            source: { kind: event.source.kind, ref: `${payload.sessionId}#fact-${index}` },
            dedupeKey: `butler-fact:${kind}:${fact.title}`,
          }),
          scope: "user",
          ownerId: payload.userId,
          kind,
          title: fact.title,
          text: fact.text,
          tags: ["butler", ...(fact.tags ?? [])],
          source: {
            kind: event.source.kind,
            ref: `${payload.sessionId}#fact-${index}`,
            version: event.occurredAt,
            ...(event.source.client === undefined ? {} : { client: event.source.client }),
          },
          confidence: fact.confidence ?? 0.85,
          sensitivity: fact.sensitivity ?? "normal",
          validFrom: event.occurredAt,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        }),
      )
    }

    return records
  }
}
