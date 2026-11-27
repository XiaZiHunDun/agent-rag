import type { AgentRagClient } from "@agent-rag/client"
import type { ProjectionEvent } from "@agent-rag/core"
import { ButlerSessionProjector } from "@agent-rag/projectors"

/**
 * WFXM butler-layer bridge.
 *
 * WFXM owns `ButlerMemoryPort` and injects this object at the composition
 * root. Session summaries become user-scope memory; raw transcripts stay in
 * the butler session store.
 */

export type WfxmButlerMemoryKind =
  | "profile"
  | "preference"
  | "relationship"
  | "commitment"
  | "convention"
  | "note"

export interface WfxmButlerFact {
  readonly title: string
  readonly text: string
  readonly kind?: WfxmButlerMemoryKind
  readonly tags?: readonly string[]
}

export interface WfxmButlerProfile {
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

export interface WfxmButlerSessionSummary {
  readonly userId: string
  readonly sessionId: string
  readonly summary: string
  readonly profile?: WfxmButlerProfile
  readonly facts?: readonly WfxmButlerFact[]
  readonly occurredAt?: string
}

export interface WfxmRecalledMemory {
  readonly title: string
  readonly text: string
}

export interface WfxmButlerMemory {
  recordSessionSummary(event: WfxmButlerSessionSummary): Promise<void>
  recallUserMemory(query: string, limit?: number): Promise<readonly WfxmRecalledMemory[]>
}

export interface WfxmButlerMemoryOptions {
  readonly client: AgentRagClient
  /** Owner whose user-scope memory is recalled. WFXM is single-owner. */
  readonly ownerId: string
  readonly clock?: () => string
  readonly recallLimit?: number
}

export function createWfxmButlerMemory(options: WfxmButlerMemoryOptions): WfxmButlerMemory {
  const projector = new ButlerSessionProjector()
  const clock = options.clock ?? (() => new Date().toISOString())
  const recallLimit = options.recallLimit ?? 5
  options.client.register(projector)

  return {
    async recordSessionSummary(event: WfxmButlerSessionSummary): Promise<void> {
      const occurredAt = event.occurredAt ?? clock()
      const projection: ProjectionEvent = {
        // occurredAt keeps successive sessions distinct for the checkpoint
        // while the projector still dedupes the profile record by key.
        id: `${event.userId}:${event.sessionId}:${occurredAt}`,
        type: "butler.session.summarized",
        occurredAt,
        source: { kind: "butler_session", ref: event.sessionId },
        payload: {
          userId: event.userId,
          sessionId: event.sessionId,
          summary: event.summary,
          ...(event.profile === undefined ? {} : { profile: event.profile }),
          ...(event.facts === undefined ? {} : { facts: event.facts }),
        },
      }
      await options.client.project(projector.name, [projection], {
        scope: { scope: "user", ownerId: event.userId },
        now: occurredAt,
      })
    },

    async recallUserMemory(query: string, limit?: number): Promise<readonly WfxmRecalledMemory[]> {
      const hits = await options.client.recall({
        scope: { scope: "user", ownerId: options.ownerId },
        text: query,
        limit: limit ?? recallLimit,
      })
      return hits.map((hit) => ({ title: hit.record.title, text: hit.record.text }))
    },
  }
}
