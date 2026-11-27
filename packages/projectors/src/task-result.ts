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

export type TaskResultStatus = "completed" | "failed" | "partial"

export interface TaskMemoryItemInput {
  readonly kind: Exclude<MemoryKind, "profile" | "preference" | "relationship" | "commitment">
  readonly title: string
  readonly text: string
  readonly tags?: readonly string[]
  readonly confidence?: number
  readonly sensitivity?: MemorySensitivity
}

export interface TaskResultPayload {
  readonly taskId: string
  readonly projectId: string
  readonly goal: string
  readonly summary: string
  readonly status: TaskResultStatus
  readonly changedFiles?: readonly string[]
  readonly tests?: {
    readonly command: string
    readonly passed: boolean
    readonly summary?: string
  }
  /** Extracted project knowledge; raw diffs/logs must stay in the task store. */
  readonly items?: readonly TaskMemoryItemInput[]
}

function summaryText(payload: TaskResultPayload): string {
  const files = payload.changedFiles ?? []
  const tests = payload.tests
  return [
    `状态：${payload.status}`,
    `目标：${payload.goal}`,
    `摘要：${payload.summary}`,
    files.length > 0 ? `改动文件：${files.join(", ")}` : "",
    tests
      ? `测试：${tests.command} → ${tests.passed ? "通过" : "失败"}${tests.summary ? `（${tests.summary}）` : ""}`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

/**
 * Projects a completed pi task (or an equivalent task result event) into
 * project-scope memory. Task summaries are stable per taskId; extracted items
 * are stable per kind+title.
 */
export class TaskResultProjector implements Projector {
  readonly name = "task-result"
  readonly sourceKind = "task_result" as const

  supports(event: ProjectionEvent): boolean {
    if (event.source.kind !== "task_result" && event.source.kind !== "pi_session") return false
    return (
      event.type === "task.completed" ||
      event.type === "task.failed" ||
      event.type === "task.partial" ||
      event.type === "pi.session.summarized"
    )
  }

  project(event: ProjectionEvent, context: ProjectionContext): readonly MemoryRecord[] {
    if (context.scope.scope !== "project") {
      throw new Error("task result projector requires a project-scope context")
    }
    const payload = event.payload as TaskResultPayload
    if (!payload || typeof payload !== "object") throw new Error("payload is required")
    if (!payload.taskId) throw new Error("payload.taskId is required")
    if (!payload.projectId) throw new Error("payload.projectId is required")
    if (payload.projectId !== context.scope.projectId) {
      throw new Error("payload.projectId does not match the projection scope")
    }
    if (!payload.goal || !payload.summary) {
      throw new Error("payload.goal and payload.summary are required")
    }

    const files = payload.changedFiles ?? []
    const records: MemoryRecord[] = [
      createMemoryRecord({
        id: stableMemoryId({
          scope: "project",
          ownerId: context.scope.ownerId,
          projectId: payload.projectId,
          kind: "task_summary",
          source: { kind: event.source.kind, ref: payload.taskId },
          dedupeKey: `task-summary:${payload.taskId}`,
        }),
        scope: "project",
        ownerId: context.scope.ownerId,
        projectId: payload.projectId,
        kind: "task_summary",
        title: `任务：${payload.goal.slice(0, 60)}`,
        text: summaryText(payload),
        facts: {
          taskId: payload.taskId,
          status: payload.status,
          changedFileCount: files.length,
          ...(payload.tests ? { testsPassed: payload.tests.passed, testCommand: payload.tests.command } : {}),
        },
        tags: ["task-summary", payload.status],
        source: {
          kind: event.source.kind,
          ref: payload.taskId,
          version: event.occurredAt,
          ...(event.source.client === undefined ? {} : { client: event.source.client }),
        },
        confidence: 0.9,
        sensitivity: "normal",
        validFrom: event.occurredAt,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      }),
    ]

    for (const [index, item] of (payload.items ?? []).entries()) {
      if (!item.title || !item.text) continue
      records.push(
        createMemoryRecord({
          id: stableMemoryId({
            scope: "project",
            ownerId: context.scope.ownerId,
            projectId: payload.projectId,
            kind: item.kind,
            source: { kind: event.source.kind, ref: `${payload.taskId}#item-${index}` },
            dedupeKey: `task-item:${item.kind}:${item.title}`,
          }),
          scope: "project",
          ownerId: context.scope.ownerId,
          projectId: payload.projectId,
          kind: item.kind,
          title: item.title,
          text: item.text,
          tags: ["task", ...(item.tags ?? [])],
          source: {
            kind: event.source.kind,
            ref: `${payload.taskId}#item-${index}`,
            version: event.occurredAt,
            ...(event.source.client === undefined ? {} : { client: event.source.client }),
          },
          confidence: item.confidence ?? 0.85,
          sensitivity: item.sensitivity ?? "normal",
          validFrom: event.occurredAt,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        }),
      )
    }

    return records
  }
}
