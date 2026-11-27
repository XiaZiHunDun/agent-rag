import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import type { MemoryFacts, MemoryKind, ProjectLocator } from "@agent-rag/core"
import type { SessionFactInput } from "@agent-rag/client"
import type { AgentRagService } from "./service.ts"

export interface McpServerOptions {
  readonly service: AgentRagService
  /** Owner used when a tool call does not pass ownerId. */
  readonly defaultOwnerId?: string
  readonly defaultProjectId?: string
  readonly defaultClient?: string
  readonly version?: string
}

const factValue = z.union([z.string(), z.number(), z.boolean(), z.null()])
const projectLocatorSchema = z.object({
  remoteUrl: z.string().optional().describe("Git remote URL; preferred stable anchor"),
  localPath: z.string().optional().describe("Absolute path to the repository"),
  name: z.string().optional().describe("Human-readable project name (weak alias)"),
})

function textResult(value: unknown): { content: { type: "text"; text: string }[] } {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  return { content: [{ type: "text", text }] }
}

/**
 * MCP stdio server exposing recall / injection / remember / reports.
 *
 * Register it in an assistant's MCP config so the assistant can read and write
 * the same memory service as other assistants.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const service = options.service
  const defaultOwnerId = options.defaultOwnerId
  const defaultProjectId = options.defaultProjectId
  const defaultClient = options.defaultClient ?? "mcp"

  const requireOwner = (): string => {
    if (!defaultOwnerId) {
      throw new Error(
        "ownerId is not configured; start agent-rag with --owner <id> or set AGENT_RAG_OWNER_ID",
      )
    }
    return defaultOwnerId
  }

  const server = new McpServer({
    name: "agent-rag",
    version: options.version ?? "0.1.0",
  })

  server.registerTool(
    "memory_context",
    {
      title: "Recall personal and project memory",
      description:
        "Return an injectable memory block for the current task. Call this at session start and prepend the text to your system prompt. Empty text means no relevant memory.",
      inputSchema: {
        goal: z.string().optional().describe("Current task goal or user request"),
        files: z.array(z.string()).optional().describe("Relevant or changed file paths"),
        projectId: z.string().optional().describe("Project id; defaults to the server project"),
        maxChars: z.number().int().positive().optional().describe("Character budget"),
      },
    },
    async (args) => {
      const projectId = args.projectId ?? defaultProjectId
      const result = await service.inject({
        ownerId: requireOwner(),
        goal: args.goal ?? "",
        ...(args.files === undefined ? {} : { files: args.files }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(args.maxChars === undefined ? {} : { maxChars: args.maxChars }),
      })
      if (!result.text) return textResult("(no relevant memory)")
      return textResult(
        `${result.text}\n\n<!-- entries=${result.entries.length} chars=${result.usedChars}${result.truncated ? " truncated" : ""} -->`,
      )
    },
  )

  server.registerTool(
    "memory_recall",
    {
      title: "Search memory",
      description:
        "Search user or project memory. User scope holds profile/preferences; project scope holds conventions, decisions and task summaries.",
      inputSchema: {
        text: z.string().describe("Search query; empty string lists recent records"),
        scope: z.enum(["user", "project"]).optional().describe("Defaults to project when projectId is known"),
        projectId: z.string().optional(),
        limit: z.number().int().positive().max(50).optional(),
        kinds: z.array(z.string()).optional().describe("Filter by memory kind"),
        includeSensitive: z.boolean().optional(),
      },
    },
    async (args) => {
      const projectId = args.projectId ?? defaultProjectId
      const scope = args.scope ?? (projectId ? "project" : "user")
      const hits = await service.recall({
        ownerId: requireOwner(),
        text: args.text,
        ...(scope === "project" && projectId ? { projectId } : {}),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.kinds === undefined ? {} : { kinds: args.kinds as MemoryKind[] }),
        ...(args.includeSensitive === undefined
          ? {}
          : { includeSensitive: args.includeSensitive }),
      })
      return textResult(
        hits.map((hit) => ({
          id: hit.record.id,
          scope: hit.record.scope,
          kind: hit.record.kind,
          title: hit.record.title,
          text: hit.record.text,
          score: Number(hit.score.toFixed(4)),
          confidence: hit.record.confidence,
          source: hit.record.source,
          updatedAt: hit.record.updatedAt,
        })),
      )
    },
  )

  server.registerTool(
    "memory_remember",
    {
      title: "Save a durable fact",
      description:
        "Save an explicit conclusion (preference, convention, decision, recipe...). Do not dump raw transcripts; keep one fact per call.",
      inputSchema: {
        kind: z
          .enum([
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
          ])
          .describe("Memory kind"),
        title: z.string().describe("Short title"),
        text: z.string().describe("Concise, self-contained statement"),
        scope: z.enum(["user", "project"]).optional(),
        projectId: z.string().optional(),
        facts: z.record(factValue).optional(),
        tags: z.array(z.string()).optional(),
        confidence: z.number().min(0).max(1).optional(),
        sensitivity: z.enum(["normal", "private", "secret"]).optional(),
      },
    },
    async (args) => {
      const projectId = args.projectId ?? defaultProjectId
      const scope = args.scope ?? (projectId ? "project" : "user")
      const record = await service.remember({
        ownerId: requireOwner(),
        kind: args.kind,
        title: args.title,
        text: args.text,
        scope,
        ...(scope === "project" && projectId ? { projectId } : {}),
        ...(args.facts === undefined ? {} : { facts: args.facts as MemoryFacts }),
        ...(args.tags === undefined ? {} : { tags: args.tags }),
        ...(args.confidence === undefined ? {} : { confidence: args.confidence }),
        ...(args.sensitivity === undefined ? {} : { sensitivity: args.sensitivity }),
        client: defaultClient,
      })
      return textResult(record)
    },
  )

  server.registerTool(
    "memory_report_task",
    {
      title: "Report task outcome",
      description:
        "After finishing a task, report its goal, summary, status and any extracted project knowledge. The server projects it into project memory.",
      inputSchema: {
        taskId: z.string(),
        goal: z.string(),
        summary: z.string(),
        status: z.enum(["completed", "failed", "partial"]),
        projectId: z.string().optional(),
        project: projectLocatorSchema.optional().describe("Resolve project from remote/path/name"),
        changedFiles: z.array(z.string()).optional(),
        tests: z
          .object({
            command: z.string(),
            passed: z.boolean(),
            summary: z.string().optional(),
          })
          .optional(),
        items: z
          .array(
            z.object({
              kind: z.enum([
                "decision",
                "convention",
                "recipe",
                "issue",
                "note",
                "task_summary",
              ]),
              title: z.string(),
              text: z.string(),
              tags: z.array(z.string()).optional(),
            }),
          )
          .optional(),
        occurredAt: z.string().optional(),
      },
    },
    async (args) => {
      const projectId = args.projectId ?? defaultProjectId
      const result = await service.reportTask({
        ownerId: requireOwner(),
        taskId: args.taskId,
        goal: args.goal,
        summary: args.summary,
        status: args.status,
        ...(projectId === undefined ? {} : { projectId }),
        ...(args.project === undefined ? {} : { project: args.project as ProjectLocator }),
        ...(args.changedFiles === undefined ? {} : { changedFiles: args.changedFiles }),
        ...(args.tests === undefined ? {} : { tests: args.tests }),
        ...(args.items === undefined ? {} : { items: args.items }),
        ...(args.occurredAt === undefined ? {} : { occurredAt: args.occurredAt }),
        client: defaultClient,
      })
      return textResult(result)
    },
  )

  server.registerTool(
    "memory_report_session",
    {
      title: "Report session summary",
      description:
        "Report a summarized session with optional profile fields and explicit facts. Raw transcripts are not accepted.",
      inputSchema: {
        sessionId: z.string(),
        summary: z.string(),
        profile: z
          .object({
            displayName: z.string().optional(),
            communicationStyle: z.string().optional(),
            preferences: z.array(z.string()).optional(),
            commitments: z.array(z.string()).optional(),
            relationships: z
              .array(
                z.object({
                  name: z.string(),
                  relation: z.string(),
                  notes: z.string().optional(),
                }),
              )
              .optional(),
          })
          .optional(),
        facts: z
          .array(
            z.object({
              title: z.string(),
              text: z.string(),
              kind: z.string().optional(),
              tags: z.array(z.string()).optional(),
            }),
          )
          .optional(),
        occurredAt: z.string().optional(),
      },
    },
    async (args) => {
      const result = await service.reportSession({
        ownerId: requireOwner(),
        sessionId: args.sessionId,
        summary: args.summary,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        ...(args.facts === undefined ? {} : { facts: args.facts as SessionFactInput[] }),
        ...(args.occurredAt === undefined ? {} : { occurredAt: args.occurredAt }),
        client: defaultClient,
      })
      return textResult(result)
    },
  )

  server.registerTool(
    "project_resolve",
    {
      title: "Resolve project identity",
      description:
        "Resolve a git remote / local path / name to a stable projectId. Different assistants resolving the same repository get the same id and share project memory.",
      inputSchema: {
        remoteUrl: z.string().optional(),
        localPath: z.string().optional(),
        name: z.string().optional(),
      },
    },
    async (args) => {
      const locator: ProjectLocator = {
        ...(args.remoteUrl === undefined ? {} : { remoteUrl: args.remoteUrl }),
        ...(args.localPath === undefined ? {} : { localPath: args.localPath }),
        ...(args.name === undefined ? {} : { name: args.name }),
      }
      return textResult(await service.resolveProject(locator))
    },
  )

  server.registerTool(
    "memory_stats",
    {
      title: "Memory statistics",
      description: "Return record counts grouped by scope.",
      inputSchema: {},
    },
    async () => textResult(await service.stats()),
  )

  return server
}

/** Connect the MCP server to stdio; never resolves while the client keeps it open. */
export async function runMcpServer(options: McpServerOptions): Promise<void> {
  const server = createMcpServer(options)
  await server.connect(new StdioServerTransport())
}
