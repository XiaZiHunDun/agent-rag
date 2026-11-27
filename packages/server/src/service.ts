import { randomUUID } from "node:crypto"
import {
  AgentRagClient,
  type MemoryInjectionRequest,
  type MemoryInjectionResult,
  type RecallRequest,
  type RememberRequest,
  type ReportResult,
  type SessionReportInput,
  type TaskReportInput,
} from "@agent-rag/client"
import {
  createMemoryRecord,
  InMemoryProjectionCheckpointStore,
  type MemoryHit,
  type MemoryRecord,
  type MemoryScopeRef,
  type MemoryStoreStats,
  type ProjectIdentity,
  type ProjectLocator,
  type ProjectRegistry,
  type ProjectionEvent,
  type TextMemoryStore,
} from "@agent-rag/core"
import { ButlerSessionProjector, TaskResultProjector } from "@agent-rag/projectors"
import { enrichProjectLocator } from "./project-discovery.ts"

export interface AgentRagServiceOptions {
  readonly store: TextMemoryStore
  readonly registry: ProjectRegistry
  /** Owner used when a request does not pass ownerId. */
  readonly defaultOwnerId?: string
  /** Assistant name recorded on writes; defaults to "api". */
  readonly defaultClient?: string
  /** Project used when a report does not pass projectId/project. */
  readonly defaultProjectId?: string
  readonly clock?: () => string
}

export interface TaskReportRequest extends TaskReportInput {
  readonly ownerId?: string
}

export interface SessionReportRequest extends SessionReportInput {
  readonly ownerId?: string
}

export interface ServiceInjectionRequest extends Omit<MemoryInjectionRequest, "ownerId"> {
  readonly ownerId?: string
}

export interface ForgetRequest {
  readonly ownerId?: string
  readonly projectId?: string
}

/** Request-level validation failure; transports map it to HTTP 400. */
export class AgentRagRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentRagRequestError"
  }
}

function taskEventType(status: TaskReportInput["status"]): string {
  if (status === "failed") return "task.failed"
  if (status === "partial") return "task.partial"
  return "task.completed"
}

/**
 * Application service shared by the HTTP and MCP transports.
 *
 * All identity (owner, project, client) resolution happens here so both
 * transports behave identically.
 */
export class AgentRagService {
  readonly client: AgentRagClient
  readonly registry: ProjectRegistry
  private readonly store: TextMemoryStore
  private readonly defaultOwnerId?: string
  private readonly defaultClient: string
  private readonly defaultProjectId?: string
  private readonly clock: () => string

  constructor(options: AgentRagServiceOptions) {
    this.store = options.store
    this.registry = options.registry
    this.defaultOwnerId = options.defaultOwnerId
    this.defaultClient = options.defaultClient ?? "api"
    this.defaultProjectId = options.defaultProjectId
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.client = new AgentRagClient({
      store: options.store,
      checkpointStore: new InMemoryProjectionCheckpointStore(),
      projectors: [new ButlerSessionProjector(), new TaskResultProjector()],
    })
  }

  async inject(request: ServiceInjectionRequest): Promise<MemoryInjectionResult> {
    const ownerId = this.requireOwner(request.ownerId)
    return this.client.inject({ ...request, ownerId })
  }

  async recall(request: RecallRequest): Promise<readonly MemoryHit[]> {
    const ownerId = this.requireOwner(request.ownerId)
    const scope: MemoryScopeRef = request.projectId
      ? { scope: "project", ownerId, projectId: request.projectId }
      : { scope: "user", ownerId }
    return this.client.recall({
      scope,
      text: request.text,
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
      ...(request.tags === undefined ? {} : { tags: request.tags }),
      ...(request.minConfidence === undefined ? {} : { minConfidence: request.minConfidence }),
      ...(request.includeSensitive === undefined
        ? {}
        : { includeSensitive: request.includeSensitive }),
      ...(request.includeExpired === undefined ? {} : { includeExpired: request.includeExpired }),
    })
  }

  async remember(request: RememberRequest): Promise<MemoryRecord> {
    const ownerId = this.requireOwner(request.ownerId)
    const scope = request.scope ?? (request.projectId ? "project" : "user")
    if (scope === "project" && !request.projectId) {
      throw new AgentRagRequestError("projectId is required for project-scope memory")
    }
    if (scope === "user" && request.projectId) {
      throw new AgentRagRequestError("projectId must be omitted for user-scope memory")
    }
    const client = request.client ?? this.defaultClient
    const record = createMemoryRecord({
      scope,
      ownerId,
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      kind: request.kind,
      title: request.title,
      text: request.text,
      ...(request.facts === undefined ? {} : { facts: request.facts }),
      ...(request.tags === undefined ? {} : { tags: request.tags }),
      source: { kind: "manual", ref: `manual:${client}:${randomUUID()}`, client },
      ...(request.confidence === undefined ? {} : { confidence: request.confidence }),
      ...(request.sensitivity === undefined ? {} : { sensitivity: request.sensitivity }),
      ...(request.validFrom === undefined ? {} : { validFrom: request.validFrom }),
      ...(request.validTo === undefined ? {} : { validTo: request.validTo }),
    })
    await this.client.remember(record)
    return record
  }

  async reportTask(request: TaskReportRequest): Promise<ReportResult> {
    const ownerId = this.requireOwner(request.ownerId)
    const projectId = await this.resolveProjectId(request)
    const occurredAt = request.occurredAt ?? this.clock()
    const client = request.client ?? this.defaultClient
    const event: ProjectionEvent = {
      id: `${projectId}:${request.taskId}:${occurredAt}`,
      type: taskEventType(request.status),
      occurredAt,
      source: { kind: "task_result", ref: request.taskId, client },
      payload: {
        taskId: request.taskId,
        projectId,
        goal: request.goal,
        summary: request.summary,
        status: request.status,
        ...(request.changedFiles === undefined ? {} : { changedFiles: request.changedFiles }),
        ...(request.tests === undefined ? {} : { tests: request.tests }),
        ...(request.items === undefined ? {} : { items: request.items }),
      },
    }
    const report = await this.client.project("task-result", [event], {
      scope: { scope: "project", ownerId, projectId },
      now: occurredAt,
    })
    return {
      projectId,
      written: report.written,
      recordIds: report.records.map((record) => record.id),
      issues: report.issues,
    }
  }

  async reportSession(request: SessionReportRequest): Promise<ReportResult> {
    const ownerId = this.requireOwner(request.ownerId)
    const occurredAt = request.occurredAt ?? this.clock()
    const client = request.client ?? this.defaultClient
    const event: ProjectionEvent = {
      id: `assistant-session:${ownerId}:${request.sessionId}:${occurredAt}`,
      type: "assistant.session.summarized",
      occurredAt,
      source: { kind: "assistant_session", ref: request.sessionId, client },
      payload: {
        userId: ownerId,
        sessionId: request.sessionId,
        summary: request.summary,
        ...(request.profile === undefined ? {} : { profile: request.profile }),
        ...(request.facts === undefined ? {} : { facts: request.facts }),
      },
    }
    const report = await this.client.project("butler-session", [event], {
      scope: { scope: "user", ownerId },
      now: occurredAt,
    })
    return {
      written: report.written,
      recordIds: report.records.map((record) => record.id),
      issues: report.issues,
    }
  }

  async resolveProject(locator: ProjectLocator): Promise<ProjectIdentity> {
    return this.registry.resolve(await enrichProjectLocator(locator))
  }

  async listProjects(): Promise<readonly ProjectIdentity[]> {
    return this.registry.list()
  }

  async stats(): Promise<MemoryStoreStats> {
    return this.client.stats()
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.client.get(id)
  }

  async forget(request: ForgetRequest): Promise<number> {
    const ownerId = this.requireOwner(request.ownerId)
    const scope: MemoryScopeRef = request.projectId
      ? { scope: "project", ownerId, projectId: request.projectId }
      : { scope: "user", ownerId }
    return this.client.forget(scope)
  }

  private async resolveProjectId(request: TaskReportRequest): Promise<string> {
    if (request.projectId) return request.projectId
    if (request.project) return (await this.resolveProject(request.project)).projectId
    if (this.defaultProjectId) return this.defaultProjectId
    throw new AgentRagRequestError("projectId or project locator is required")
  }

  private requireOwner(ownerId: string | undefined): string {
    const resolved = ownerId ?? this.defaultOwnerId
    if (!resolved) throw new AgentRagRequestError("ownerId is required")
    return resolved
  }
}
