import type { AgentRagClient } from "@agent-rag/client"
import type { ProjectionEvent } from "@agent-rag/core"
import { TaskResultProjector } from "@agent-rag/projectors"

/**
 * WFXM task-layer bridge.
 *
 * WFXM owns the `TaskMemoryPort` interface and never imports this package; the
 * composition root injects the returned object. The input shape mirrors
 * WFXM's `TaskMemoryEvent` structurally, so both sides stay decoupled.
 */

export type WfxmTaskMemoryStatus = "completed" | "failed" | "partial"

export interface WfxmTaskOutcome {
  readonly taskId: string
  readonly projectId: string
  readonly goal: string
  readonly summary: string
  readonly status: WfxmTaskMemoryStatus
  readonly changedFiles?: readonly string[]
  readonly tests?: {
    readonly command: string
    readonly passed: boolean
    readonly summary?: string
  }
  readonly occurredAt?: string
}

export interface WfxmTaskMemory {
  recordTaskOutcome(event: WfxmTaskOutcome): Promise<void>
}

export interface WfxmTaskMemoryOptions {
  readonly client: AgentRagClient
  readonly ownerId: string
  readonly clock?: () => string
}

function eventTypeFor(status: WfxmTaskMemoryStatus): string {
  if (status === "failed") return "task.failed"
  if (status === "partial") return "task.partial"
  return "task.completed"
}

export function createWfxmTaskMemory(options: WfxmTaskMemoryOptions): WfxmTaskMemory {
  const projector = new TaskResultProjector()
  const clock = options.clock ?? (() => new Date().toISOString())
  options.client.register(projector)

  return {
    async recordTaskOutcome(outcome: WfxmTaskOutcome): Promise<void> {
      const occurredAt = outcome.occurredAt ?? clock()
      const event: ProjectionEvent = {
        // occurredAt keeps successive turns of the same task distinct, so a
        // projection checkpoint never swallows a newer summary.
        id: `${outcome.projectId}:${outcome.taskId}:${occurredAt}`,
        type: eventTypeFor(outcome.status),
        occurredAt,
        source: { kind: "task_result", ref: outcome.taskId },
        payload: {
          taskId: outcome.taskId,
          projectId: outcome.projectId,
          goal: outcome.goal,
          summary: outcome.summary,
          status: outcome.status,
          ...(outcome.changedFiles === undefined ? {} : { changedFiles: outcome.changedFiles }),
          ...(outcome.tests === undefined ? {} : { tests: outcome.tests }),
        },
      }
      await options.client.project(projector.name, [event], {
        scope: { scope: "project", ownerId: options.ownerId, projectId: outcome.projectId },
        now: occurredAt,
      })
    },
  }
}
