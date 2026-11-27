import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  MemoryValidationError,
  ProjectIdentityError,
  type MemoryFacts,
  type ProjectLocator,
} from "@agent-rag/core"
import type {
  MemoryItemInput,
  RecallRequest,
  RememberRequest,
  SessionFactInput,
  SessionProfileInput,
  TaskReportInput,
} from "@agent-rag/client"
import { AgentRagRequestError, type AgentRagService } from "./service.ts"

type TaskTests = NonNullable<TaskReportInput["tests"]>

export interface HttpServerOptions {
  readonly service: AgentRagService
  /** When set, every non-health request must send `Authorization: Bearer <token>`. */
  readonly token?: string
  readonly maxBodyBytes?: number
  readonly name?: string
  readonly version?: string
}

class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = "HttpError"
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  })
  response.end(body)
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new HttpError(413, "request body too large")
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new HttpError(400, "invalid JSON body")
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "body must be a JSON object")
  }
  return value as Record<string, unknown>
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string`)
  return value
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body, key)
  if (!value || value.trim().length === 0) throw new HttpError(400, `${key} is required`)
  return value
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, `${key} must be a number`)
  }
  return value
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new HttpError(400, `${key} must be a boolean`)
  return value
}

function optionalStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new HttpError(400, `${key} must be an array of strings`)
  }
  return value as string[]
}

function optionalObject<T>(body: Record<string, unknown>, key: string): T | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${key} must be an object`)
  }
  return value as T
}

function optionalObjectArray<T>(body: Record<string, unknown>, key: string): T[] | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new HttpError(400, `${key} must be an array`)
  return value as T[]
}

function statusFor(error: unknown): number {
  if (error instanceof HttpError) return error.status
  if (
    error instanceof MemoryValidationError ||
    error instanceof ProjectIdentityError ||
    error instanceof AgentRagRequestError
  ) {
    return 400
  }
  return 500
}

function errorMessage(error: unknown, status: number): string {
  if (status >= 500) return "internal server error"
  return error instanceof Error ? error.message : String(error)
}

/**
 * Dependency-free HTTP JSON API.
 *
 * Binds to localhost by default at the CLI layer; set a token when exposing the
 * service to other machines.
 */
export function createHttpServer(options: HttpServerOptions): ReturnType<typeof createServer> {
  const service = options.service
  const token = options.token
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000
  const name = options.name ?? "agent-rag"
  const version = options.version ?? "0.1.0"

  return createServer((request, response) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost")
        const path = url.pathname

        if (request.method === "GET" && path === "/health") {
          const stats = await service.stats()
          sendJson(response, 200, { ok: true, name, version, total: stats.total })
          return
        }

        if (token !== undefined && request.headers.authorization !== `Bearer ${token}`) {
          sendJson(response, 401, { error: "unauthorized" })
          return
        }

        if (request.method === "GET" && path === "/v1/stats") {
          sendJson(response, 200, await service.stats())
          return
        }
        if (request.method === "GET" && path === "/v1/projects") {
          sendJson(response, 200, { projects: await service.listProjects() })
          return
        }

        const body = asObject(await readJson(request, maxBodyBytes))

        if (request.method === "POST" && path === "/v1/projects/resolve") {
          const locator: ProjectLocator = {
            ...(optionalString(body, "remoteUrl") === undefined
              ? {}
              : { remoteUrl: optionalString(body, "remoteUrl") }),
            ...(optionalString(body, "localPath") === undefined
              ? {}
              : { localPath: optionalString(body, "localPath") }),
            ...(optionalString(body, "name") === undefined
              ? {}
              : { name: optionalString(body, "name") }),
          }
          sendJson(response, 200, { project: await service.resolveProject(locator) })
          return
        }

        if (request.method === "POST" && path === "/v1/context") {
          const result = await service.inject({
            ...(optionalString(body, "ownerId") === undefined
              ? {}
              : { ownerId: optionalString(body, "ownerId") }),
            ...(optionalString(body, "projectId") === undefined
              ? {}
              : { projectId: optionalString(body, "projectId") }),
            goal: optionalString(body, "goal") ?? "",
            ...(optionalStringArray(body, "files") === undefined
              ? {}
              : { files: optionalStringArray(body, "files") }),
            ...(optionalNumber(body, "maxChars") === undefined
              ? {}
              : { maxChars: optionalNumber(body, "maxChars") }),
            ...(optionalBoolean(body, "includeSensitive") === undefined
              ? {}
              : { includeSensitive: optionalBoolean(body, "includeSensitive") }),
          })
          sendJson(response, 200, result)
          return
        }

        if (request.method === "POST" && path === "/v1/recall") {
          const recall: RecallRequest = {
            ...(optionalString(body, "ownerId") === undefined
              ? {}
              : { ownerId: optionalString(body, "ownerId") }),
            ...(optionalString(body, "projectId") === undefined
              ? {}
              : { projectId: optionalString(body, "projectId") }),
            text: optionalString(body, "text") ?? "",
            ...(optionalNumber(body, "limit") === undefined
              ? {}
              : { limit: optionalNumber(body, "limit") }),
            ...(optionalStringArray(body, "kinds") === undefined
              ? {}
              : { kinds: optionalStringArray(body, "kinds") as RecallRequest["kinds"] }),
            ...(optionalStringArray(body, "tags") === undefined
              ? {}
              : { tags: optionalStringArray(body, "tags") }),
            ...(optionalNumber(body, "minConfidence") === undefined
              ? {}
              : { minConfidence: optionalNumber(body, "minConfidence") }),
            ...(optionalBoolean(body, "includeSensitive") === undefined
              ? {}
              : { includeSensitive: optionalBoolean(body, "includeSensitive") }),
            ...(optionalBoolean(body, "includeExpired") === undefined
              ? {}
              : { includeExpired: optionalBoolean(body, "includeExpired") }),
          }
          sendJson(response, 200, { hits: await service.recall(recall) })
          return
        }

        if (request.method === "POST" && path === "/v1/remember") {
          const remember: RememberRequest = {
            ...(optionalString(body, "ownerId") === undefined
              ? {}
              : { ownerId: optionalString(body, "ownerId") }),
            ...(optionalString(body, "projectId") === undefined
              ? {}
              : { projectId: optionalString(body, "projectId") }),
            scope: optionalString(body, "scope") as RememberRequest["scope"],
            kind: requiredString(body, "kind") as RememberRequest["kind"],
            title: requiredString(body, "title"),
            text: requiredString(body, "text"),
            ...(optionalObject<MemoryFacts>(body, "facts") === undefined
              ? {}
              : { facts: optionalObject<MemoryFacts>(body, "facts") }),
            ...(optionalStringArray(body, "tags") === undefined
              ? {}
              : { tags: optionalStringArray(body, "tags") }),
            ...(optionalNumber(body, "confidence") === undefined
              ? {}
              : { confidence: optionalNumber(body, "confidence") }),
            ...(optionalString(body, "sensitivity") === undefined
              ? {}
              : { sensitivity: optionalString(body, "sensitivity") as RememberRequest["sensitivity"] }),
            ...(optionalString(body, "client") === undefined
              ? {}
              : { client: optionalString(body, "client") }),
            ...(optionalString(body, "validFrom") === undefined
              ? {}
              : { validFrom: optionalString(body, "validFrom") }),
            ...(optionalString(body, "validTo") === undefined
              ? {}
              : { validTo: optionalString(body, "validTo") }),
          }
          sendJson(response, 200, { record: await service.remember(remember) })
          return
        }

        if (request.method === "POST" && path === "/v1/tasks/report") {
          const status = requiredString(body, "status")
          if (status !== "completed" && status !== "failed" && status !== "partial") {
            throw new HttpError(400, "status must be completed, failed, or partial")
          }
          const result = await service.reportTask({
            ...(optionalString(body, "ownerId") === undefined
              ? {}
              : { ownerId: optionalString(body, "ownerId") }),
            ...(optionalString(body, "projectId") === undefined
              ? {}
              : { projectId: optionalString(body, "projectId") }),
            ...(optionalObject<ProjectLocator>(body, "project") === undefined
              ? {}
              : { project: optionalObject<ProjectLocator>(body, "project") }),
            taskId: requiredString(body, "taskId"),
            goal: requiredString(body, "goal"),
            summary: requiredString(body, "summary"),
            status,
            ...(optionalStringArray(body, "changedFiles") === undefined
              ? {}
              : { changedFiles: optionalStringArray(body, "changedFiles") }),
            ...(optionalObject<TaskTests>(body, "tests") === undefined
              ? {}
              : { tests: optionalObject<TaskTests>(body, "tests") }),
            ...(optionalObjectArray<MemoryItemInput>(body, "items") === undefined
              ? {}
              : { items: optionalObjectArray<MemoryItemInput>(body, "items") }),
            ...(optionalString(body, "client") === undefined
              ? {}
              : { client: optionalString(body, "client") }),
            ...(optionalString(body, "occurredAt") === undefined
              ? {}
              : { occurredAt: optionalString(body, "occurredAt") }),
          })
          sendJson(response, 200, result)
          return
        }

        if (request.method === "POST" && path === "/v1/sessions/report") {
          const result = await service.reportSession({
            ...(optionalString(body, "ownerId") === undefined
              ? {}
              : { ownerId: optionalString(body, "ownerId") }),
            sessionId: requiredString(body, "sessionId"),
            summary: optionalString(body, "summary") ?? "",
            ...(optionalObject<SessionProfileInput>(body, "profile") === undefined
              ? {}
              : { profile: optionalObject<SessionProfileInput>(body, "profile") }),
            ...(optionalObjectArray<SessionFactInput>(body, "facts") === undefined
              ? {}
              : { facts: optionalObjectArray<SessionFactInput>(body, "facts") }),
            ...(optionalString(body, "client") === undefined
              ? {}
              : { client: optionalString(body, "client") }),
            ...(optionalString(body, "occurredAt") === undefined
              ? {}
              : { occurredAt: optionalString(body, "occurredAt") }),
          })
          sendJson(response, 200, result)
          return
        }

        if (request.method === "POST" && path === "/v1/forget") {
          const deleted = await service.forget({
            ...(optionalString(body, "ownerId") === undefined
              ? {}
              : { ownerId: optionalString(body, "ownerId") }),
            ...(optionalString(body, "projectId") === undefined
              ? {}
              : { projectId: optionalString(body, "projectId") }),
          })
          sendJson(response, 200, { deleted })
          return
        }

        if (
          path === "/v1/context" ||
          path === "/v1/recall" ||
          path === "/v1/remember" ||
          path === "/v1/tasks/report" ||
          path === "/v1/sessions/report" ||
          path === "/v1/forget" ||
          path === "/v1/projects/resolve"
        ) {
          sendJson(response, 405, { error: "method not allowed" })
          return
        }

        sendJson(response, 404, { error: "not found" })
      } catch (error) {
        const status = statusFor(error)
        if (status >= 500) console.error("[agent-rag]", error)
        sendJson(response, status, { error: errorMessage(error, status) })
      }
    })()
  })
}
