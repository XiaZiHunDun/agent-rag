import type {
  MemoryHit,
  MemoryRecord,
  MemoryStoreStats,
  ProjectIdentity,
  ProjectLocator,
} from "@agent-rag/core"
import type {
  MemoryInjectionRequest,
  MemoryInjectionResult,
  RecallRequest,
  RememberRequest,
  ReportResult,
  SessionReportInput,
  TaskReportInput,
} from "./injection.ts"

export interface AgentRagHttpClientOptions {
  /** Base URL, e.g. http://127.0.0.1:8787 */
  readonly baseUrl: string
  readonly token?: string
  /** Default owner for all calls; can be overridden per request. */
  readonly ownerId?: string
  /** Assistant name attached to writes, e.g. "dsh-wfxm". */
  readonly client?: string
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

export class AgentRagHttpClientError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `agent-rag request failed with status ${status}`
    super(message)
    this.name = "AgentRagHttpClientError"
    this.status = status
    this.body = body
  }
}

export interface AgentRagHealth {
  readonly ok: boolean
  readonly name: string
  readonly version: string
  readonly total: number
}

type OwnerScoped<T> = Omit<T, "ownerId"> & { readonly ownerId?: string }

/**
 * HTTP client for a shared agent-rag server.
 *
 * Use this when multiple assistants should read and write the same memory
 * service instead of embedding their own store.
 */
export class AgentRagHttpClient {
  private readonly baseUrl: string
  private readonly token?: string
  private readonly defaultOwnerId?: string
  private readonly clientName?: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: AgentRagHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "")
    this.token = options.token
    this.defaultOwnerId = options.ownerId
    this.clientName = options.client
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  async health(): Promise<AgentRagHealth> {
    return this.call<AgentRagHealth>("GET", "/health")
  }

  async inject(
    request: OwnerScoped<MemoryInjectionRequest>,
  ): Promise<MemoryInjectionResult> {
    return this.call<MemoryInjectionResult>("POST", "/v1/context", this.withOwner(request))
  }

  async recall(request: RecallRequest): Promise<readonly MemoryHit[]> {
    const result = await this.call<{ hits: readonly MemoryHit[] }>(
      "POST",
      "/v1/recall",
      this.withOwner(request),
    )
    return result.hits
  }

  async remember(request: RememberRequest): Promise<MemoryRecord> {
    const body = {
      ...this.withOwner(request),
      ...(request.client === undefined && this.clientName !== undefined
        ? { client: this.clientName }
        : {}),
    }
    const result = await this.call<{ record: MemoryRecord }>("POST", "/v1/remember", body)
    return result.record
  }

  async reportTask(request: OwnerScoped<TaskReportInput>): Promise<ReportResult> {
    return this.call<ReportResult>("POST", "/v1/tasks/report", this.withWriteDefaults(request))
  }

  async reportSession(request: OwnerScoped<SessionReportInput>): Promise<ReportResult> {
    return this.call<ReportResult>("POST", "/v1/sessions/report", this.withWriteDefaults(request))
  }

  async resolveProject(locator: ProjectLocator): Promise<ProjectIdentity> {
    const result = await this.call<{ project: ProjectIdentity }>(
      "POST",
      "/v1/projects/resolve",
      locator,
    )
    return result.project
  }

  async listProjects(): Promise<readonly ProjectIdentity[]> {
    const result = await this.call<{ projects: readonly ProjectIdentity[] }>(
      "GET",
      "/v1/projects",
    )
    return result.projects
  }

  async stats(): Promise<MemoryStoreStats> {
    return this.call<MemoryStoreStats>("GET", "/v1/stats")
  }

  async forget(
    request: { readonly ownerId?: string; readonly projectId?: string } = {},
  ): Promise<number> {
    const result = await this.call<{ deleted: number }>(
      "POST",
      "/v1/forget",
      this.withOwner(request),
    )
    return result.deleted
  }

  private withOwner<T extends { readonly ownerId?: string }>(
    request: T,
  ): Omit<T, "ownerId"> & { ownerId: string } {
    const ownerId = request.ownerId ?? this.defaultOwnerId
    if (!ownerId) throw new Error("ownerId is required (pass it per call or in the constructor)")
    return { ...request, ownerId }
  }

  private withWriteDefaults<T extends { readonly ownerId?: string; readonly client?: string }>(
    request: T,
  ): { ownerId: string; client?: string } & T {
    const ownerId = request.ownerId ?? this.defaultOwnerId
    if (!ownerId) throw new Error("ownerId is required (pass it per call or in the constructor)")
    const client = request.client ?? this.clientName
    return {
      ...request,
      ownerId,
      ...(client === undefined ? {} : { client }),
    } as { ownerId: string; client?: string } & T
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" }
    if (body !== undefined) headers["content-type"] = "application/json"
    if (this.token) headers["authorization"] = `Bearer ${this.token}`

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    const text = await response.text()
    let payload: unknown
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = text
      }
    }
    if (!response.ok) throw new AgentRagHttpClientError(response.status, payload)
    return payload as T
  }
}
