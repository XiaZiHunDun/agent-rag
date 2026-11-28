import { open, readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { AgentRagHttpClient, collectInjection } from "@agent-rag/client"
import {
  MEMORY_KINDS,
  isExpired,
  recordMatchesScope,
  type MemoryKind,
} from "@agent-rag/core"
import { createHttpServer } from "./http-server.ts"
import { parseMemoryJsonl, serializeMemoryJsonl } from "./memory-jsonl.ts"
import { runMcpServer } from "./mcp-server.ts"
import { enrichProjectLocator } from "./project-discovery.ts"
import { AgentRagService } from "./service.ts"
import { openStores, type OpenedStores, type StoreKind } from "./store-factory.ts"

const VERSION = "0.1.0"

interface CliValues {
  readonly "data-dir"?: string
  readonly store?: string
  readonly owner?: string
  readonly user?: string
  readonly project?: string
  readonly "project-id"?: string
  readonly client?: string
  readonly host?: string
  readonly port?: string
  readonly token?: string
  readonly remote?: string
  readonly "remote-url"?: string
  readonly path?: string
  readonly name?: string
  readonly goal?: string
  readonly text?: string
  /** Single-valued for remember; repeatable for recall. */
  readonly kind?: string | readonly string[]
  readonly title?: string
  readonly scope?: string
  readonly limit?: string
  readonly "max-chars"?: string
  readonly "min-confidence"?: string
  readonly sensitivity?: string
  readonly tag?: string[]
  readonly "include-expired"?: boolean
  readonly "include-sensitive"?: boolean
  readonly "by-kind"?: boolean
  readonly "by-source"?: boolean
  readonly out?: string
  readonly in?: string
  readonly id?: string
  readonly source?: string
  readonly force?: boolean
  readonly expired?: boolean
  readonly "dry-run"?: boolean
  readonly yes?: boolean
  readonly help?: boolean
}

const USAGE = `agent-rag ${VERSION} — personal memory for coding assistants

Usage:
  agent-rag <command> [options]

Commands:
  version [--json]        Print the CLI version (also --version)
  mcp                     Run an MCP stdio server (for dsh-wfxm, IDE agents)
  serve                   Run the HTTP JSON API server
  inject                  Print an injectable memory block for a goal
  recall [query]          Search memory and print hits as JSON
  remember                Save one durable fact
  forget                  Delete a whole scope, one source, or one id
  purge --expired         Delete every record whose validTo has passed
  resolve                 Resolve a project locator to a stable projectId
  stats                   Print record counts by scope, kind or source
  export --out <path>     Export all memory records as JSONL
  import --in <path>      Import memory records from a JSONL file

Common options:
  --owner <id>            Canonical user id (or AGENT_RAG_OWNER_ID)
  --client <name>         Assistant name recorded on writes (default: cli)
  --data-dir <dir>        Data directory (default: ~/.agent-rag, or AGENT_RAG_HOME)
  --store json|memory     Store backend (default: json)
  --project <path>        Local repository path; resolved to a projectId
  --project-id <id>       Explicit project id

serve options:
  --host <host>           Default 127.0.0.1
  --port <port>           Default 8787
  --token <token>         Require Authorization: Bearer <token> (or AGENT_RAG_TOKEN)

mcp options:
  --remote <url>          Use a shared agent-rag server instead of a local store
                          (or AGENT_RAG_REMOTE, e.g. http://127.0.0.1:8787)
  --token <token>         Token for the shared server (or AGENT_RAG_TOKEN)
  --project <path>        Resolved remotely to a projectId on the shared server

inject options:
  --goal <text>           Current task goal
  --max-chars <n>         Context budget (default: 2500)

recall options:
  --kind <kind>           Filter by memory kind; repeat for any-of
  --tag <tag>             Filter by tag; repeat for any-of
  --min-confidence <n>    Only records with confidence >= n (0..1)
  --include-expired       Include records whose validTo has passed
  --include-sensitive     Include sensitivity=secret records
  --limit <n>             Max hits (default: 10, max: 50)

remember options:
  --kind <kind>           Single value: profile|preference|decision|...
  --title <title> --text <text>
  --scope user|project    Default: project when a project id is known
  --tag <tag>             Repeatable
  --sensitivity <level>   normal|private|secret

stats options:
  --by-kind               Include per-kind record counts
  --by-source             Include per-source.client record counts; records
                          without source.client are counted as unknown

forget options:
  --id <id>               Delete exactly one record by id, regardless of scope
  --source <client>       Delete every record whose source.client matches,
                          across user and project scopes
  --dry-run               Preview the matched/deleted counts; never writes
  --yes                   Required to actually delete
  --id and --source are mutually exclusive. Without either, deletes the
  current scope: project when --project or --project-id is given, otherwise
  the user scope.

purge options:
  --expired               Required; select records whose validTo has passed
                          across user and project scopes
  --dry-run               Preview matched/deleted counts; never writes
  --yes                   Required to actually delete

export options:
  --out <path>            Destination JSONL file (required)
  --force                 Overwrite the destination if it already exists

import options:
  --in <path>             Source JSONL file (required)
                          Records are upserted by id; an invalid line aborts
                          the whole import without writing anything.

Examples:
  agent-rag mcp --owner user_me --project ~/projects/agent-rag
  agent-rag mcp --remote http://127.0.0.1:8787 --project ~/projects/agent-rag
  agent-rag serve --owner user_me --port 8787
  agent-rag inject --owner user_me --project . --goal "修复登录超时"
  agent-rag recall --owner user_me --project . 发布 --kind convention --tag release
  agent-rag recall --owner user_me --include-sensitive --include-expired
  agent-rag resolve --remote-url git@github.com:owner/repo.git
  agent-rag forget --owner user_me --project . --yes
  agent-rag forget --source wfxm --yes
  agent-rag forget --id mem_abc123 --yes
  agent-rag stats --by-kind --by-source
  agent-rag purge --expired --dry-run
  agent-rag purge --expired --yes
  agent-rag export --out ~/agent-rag-backup.jsonl
  agent-rag import --in ~/agent-rag-backup.jsonl
`

function requireOwner(values: CliValues): string {
  const ownerId = values.owner ?? values.user ?? process.env["AGENT_RAG_OWNER_ID"]
  if (!ownerId) {
    throw new Error("owner is required: pass --owner <id> or set AGENT_RAG_OWNER_ID")
  }
  return ownerId
}

function storeKind(values: CliValues): StoreKind {
  const kind = values.store ?? "json"
  if (kind !== "json" && kind !== "memory") {
    throw new Error(`unknown store: ${kind} (expected json or memory)`)
  }
  return kind
}

async function loadStores(values: CliValues): Promise<OpenedStores> {
  return openStores({
    store: storeKind(values),
    ...(values["data-dir"] === undefined ? {} : { dataDir: values["data-dir"] }),
  })
}

async function resolveProjectId(
  stores: OpenedStores,
  values: CliValues,
): Promise<string | undefined> {
  if (values["project-id"]) return values["project-id"]
  const localPath = values.project ?? values.path
  if (!localPath) return undefined
  return (await stores.registry.resolve(await enrichProjectLocator({ localPath }))).projectId
}

function createService(
  stores: OpenedStores,
  values: CliValues,
  projectId: string | undefined,
): AgentRagService {
  const ownerId = values.owner ?? values.user ?? process.env["AGENT_RAG_OWNER_ID"]
  return new AgentRagService({
    store: stores.store,
    registry: stores.registry,
    ...(ownerId === undefined ? {} : { defaultOwnerId: ownerId }),
    defaultClient: values.client ?? process.env["AGENT_RAG_CLIENT"] ?? "cli",
    ...(projectId === undefined ? {} : { defaultProjectId: projectId }),
  })
}

function resolveToken(values: CliValues): string | undefined {
  return values.token ?? process.env["AGENT_RAG_TOKEN"]
}

async function commandServe(values: CliValues): Promise<void> {
  const stores = await loadStores(values)
  const projectId = await resolveProjectId(stores, values)
  const service = createService(stores, values, projectId)
  const host = values.host ?? "127.0.0.1"
  const port = Number(values.port ?? 8787)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${values.port}`)
  }

  const token = resolveToken(values)
  const server = createHttpServer({
    service,
    name: "agent-rag",
    version: VERSION,
    ...(token === undefined ? {} : { token }),
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, resolve)
  })
  console.log(`agent-rag ${VERSION} listening on http://${host}:${port}`)
  if (stores.memoryFile) console.log(`memory: ${stores.memoryFile}`)
  if (projectId) console.log(`default project: ${projectId}`)

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close(() => process.exit(0))
    })
  }
}

async function commandMcp(values: CliValues): Promise<void> {
  const ownerId = requireOwner(values)
  const clientName = values.client ?? process.env["AGENT_RAG_CLIENT"] ?? "mcp"
  const remote = values.remote ?? process.env["AGENT_RAG_REMOTE"]

  if (remote) {
    const token = resolveToken(values)
    const http = new AgentRagHttpClient({
      baseUrl: remote,
      ownerId,
      client: clientName,
      ...(token === undefined ? {} : { token }),
    })
    let projectId = values["project-id"]
    const localPath = values.project ?? values.path
    if (projectId === undefined && localPath !== undefined) {
      const locator = await enrichProjectLocator({ localPath })
      projectId = (await http.resolveProject(locator)).projectId
    }
    console.error(
      `[agent-rag] mcp remote=${remote} owner=${ownerId}${projectId ? ` project=${projectId}` : ""}`,
    )
    await runMcpServer({
      service: http,
      defaultOwnerId: ownerId,
      ...(projectId === undefined ? {} : { defaultProjectId: projectId }),
      defaultClient: clientName,
      version: VERSION,
    })
    return
  }

  const stores = await loadStores(values)
  const projectId = await resolveProjectId(stores, values)
  const service = createService(stores, values, projectId)
  // MCP uses stdout for the protocol; logs must go to stderr.
  console.error(
    `[agent-rag] mcp ready owner=${ownerId}${projectId ? ` project=${projectId}` : ""}`,
  )
  await runMcpServer({
    service,
    defaultOwnerId: ownerId,
    ...(projectId === undefined ? {} : { defaultProjectId: projectId }),
    defaultClient: clientName,
    version: VERSION,
  })
}

async function commandResolve(values: CliValues): Promise<void> {
  const stores = await loadStores(values)
  const localPath = values.path ?? values.project
  const identity = await stores.registry.resolve(
    await enrichProjectLocator({
      ...(values["remote-url"] === undefined ? {} : { remoteUrl: values["remote-url"] }),
      ...(localPath === undefined ? {} : { localPath }),
      ...(values.name === undefined ? {} : { name: values.name }),
    }),
  )
  console.log(JSON.stringify(identity, null, 2))
}

async function commandStats(values: CliValues): Promise<void> {
  const stores = await loadStores(values)
  const stats = await stores.store.stats()
  const output: {
    total: number
    byScope: Readonly<Record<string, number>>
    byKind?: Readonly<Record<string, number>>
    bySource?: Readonly<Record<string, number>>
  } = { total: stats.total, byScope: stats.byScope }
  if (values["by-kind"]) output.byKind = stats.byKind ?? {}
  if (values["by-source"]) output.bySource = stats.bySource ?? {}
  console.log(JSON.stringify(output, null, 2))
}

async function commandExport(values: CliValues): Promise<void> {
  if (!values.out) {
    throw new Error("export requires --out <path>")
  }
  const stores = await loadStores(values)
  const records = await stores.store.listAll()
  const content = serializeMemoryJsonl(records)

  if (values.force) {
    await writeFile(values.out, content, "utf8")
  } else {
    try {
      const handle = await open(values.out, "wx")
      try {
        await handle.writeFile(content, "utf8")
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`refusing to overwrite existing file: ${values.out} (use --force)`)
      }
      throw error
    }
  }

  console.log(JSON.stringify({ exported: records.length, out: values.out }, null, 2))
}

async function commandImport(values: CliValues): Promise<void> {
  if (!values.in) {
    throw new Error("import requires --in <path>")
  }
  const content = await readFile(values.in, "utf8")
  // Parse and validate the whole file before opening the store or writing
  // anything, so a bad line leaves the target store untouched.
  const records = parseMemoryJsonl(content)
  const stores = await loadStores(values)
  await stores.store.upsertMany(records)
  console.log(JSON.stringify({ imported: records.length, in: values.in }, null, 2))
}

const RECALL_KINDS: ReadonlySet<string> = new Set(MEMORY_KINDS)

function parseRecallKinds(
  raw: string | readonly string[] | undefined,
): readonly MemoryKind[] | undefined {
  if (raw === undefined) return undefined
  const values = Array.isArray(raw) ? raw : [raw]
  const kinds: MemoryKind[] = []
  for (const value of values) {
    const kind = value.trim()
    if (!RECALL_KINDS.has(kind as MemoryKind)) {
      throw new Error(
        `invalid --kind: ${value} (expected one of ${[...RECALL_KINDS].join("|")})`,
      )
    }
    if (!kinds.includes(kind as MemoryKind)) kinds.push(kind as MemoryKind)
  }
  return kinds
}

function parseRecallTags(raw: readonly string[] | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined
  const tags: string[] = []
  for (const value of raw) {
    const tag = value.trim()
    if (!tag) throw new Error("invalid --tag: tag must be a non-empty string")
    if (!tags.includes(tag)) tags.push(tag)
  }
  return tags
}

function parseMinConfidence(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw.trim())
  if (!raw.trim() || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid --min-confidence: ${raw} (expected a number between 0 and 1)`)
  }
  return value
}

async function commandRecall(values: CliValues, positionals: readonly string[]): Promise<void> {
  const ownerId = requireOwner(values)
  const kinds = parseRecallKinds(values.kind)
  const tags = parseRecallTags(values.tag)
  const minConfidence = parseMinConfidence(values["min-confidence"])
  const stores = await loadStores(values)
  const projectId = await resolveProjectId(stores, values)
  const service = createService(stores, values, projectId)
  const hits = await service.recall({
    ownerId,
    text: values.text ?? positionals.join(" "),
    ...(projectId === undefined ? {} : { projectId }),
    ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
    ...(kinds === undefined ? {} : { kinds }),
    ...(tags === undefined ? {} : { tags }),
    ...(minConfidence === undefined ? {} : { minConfidence }),
    ...(values["include-expired"] ? { includeExpired: true } : {}),
    ...(values["include-sensitive"] ? { includeSensitive: true } : {}),
  })
  console.log(JSON.stringify(hits, null, 2))
}

async function commandInject(values: CliValues, positionals: readonly string[]): Promise<void> {
  const ownerId = requireOwner(values)
  const stores = await loadStores(values)
  const projectId = await resolveProjectId(stores, values)
  const result = await collectInjection(stores.store, {
    ownerId,
    goal: values.goal ?? positionals.join(" "),
    ...(projectId === undefined ? {} : { projectId }),
    ...(values["max-chars"] === undefined ? {} : { maxChars: Number(values["max-chars"]) }),
  })
  if (result.text) console.log(result.text)
  console.error(
    `[agent-rag] entries=${result.entries.length} chars=${result.usedChars}${result.truncated ? " truncated" : ""}`,
  )
}

async function commandRemember(values: CliValues): Promise<void> {
  const ownerId = requireOwner(values)
  // remember's --kind is parsed as a single string (repeated flags keep the
  // last value, as before); recall is the only command with an array.
  const kind = Array.isArray(values.kind) ? values.kind.at(-1) : values.kind
  if (!kind || !values.title || !values.text) {
    throw new Error("remember requires --kind, --title and --text")
  }
  const stores = await loadStores(values)
  const projectId = await resolveProjectId(stores, values)
  const service = createService(stores, values, projectId)
  const scope = values.scope ?? (projectId ? "project" : "user")
  if (scope !== "user" && scope !== "project") {
    throw new Error(`invalid scope: ${scope}`)
  }
  const record = await service.remember({
    ownerId,
    scope,
    ...(scope === "project" && projectId ? { projectId } : {}),
    kind: kind as MemoryKind,
    title: values.title,
    text: values.text,
    ...(values.tag === undefined ? {} : { tags: values.tag }),
    ...(values.sensitivity === undefined
      ? {}
      : { sensitivity: values.sensitivity as "normal" | "private" | "secret" }),
  })
  console.log(JSON.stringify(record, null, 2))
}

async function commandForgetById(values: CliValues, rawId: string): Promise<void> {
  const id = rawId.trim()
  if (!id) {
    throw new Error("forget --id requires a non-empty id")
  }

  const stores = await loadStores(values)
  const record = await stores.store.get(id)
  if (!record) {
    console.error(`[agent-rag] memory not found: ${id}`)
    process.exitCode = 1
    return
  }

  // Like the other forget modes: preview unless --yes is present, and
  // --dry-run always wins so an explicit dry-run can never write.
  const dryRun = values["dry-run"] === true || values.yes !== true
  let deleted = 0
  if (!dryRun) {
    await stores.store.delete(id)
    deleted = 1
  }

  console.log(JSON.stringify({ id, matched: 1, deleted, dryRun }, null, 2))
}

async function commandForgetBySource(values: CliValues, source: string): Promise<void> {
  const client = source.trim()
  if (!client) {
    throw new Error("forget --source requires a non-empty client name")
  }

  const stores = await loadStores(values)
  const records = await stores.store.listAll()
  const matches = records.filter((record) => record.source?.client === client)
  // Without --yes this is a preview; --dry-run makes that explicit even when
  // --yes is present.
  const dryRun = values["dry-run"] === true || values.yes !== true

  let deleted = 0
  if (!dryRun) {
    for (const record of matches) {
      await stores.store.delete(record.id)
      deleted += 1
    }
  }

  console.log(
    JSON.stringify({ source: client, matched: matches.length, deleted, dryRun }, null, 2),
  )
}

async function commandPurge(values: CliValues): Promise<void> {
  if (values.expired !== true) {
    throw new Error("purge requires --expired")
  }

  const stores = await loadStores(values)
  const now = new Date().toISOString()
  const records = await stores.store.listAll()
  const matches = records.filter((record) => isExpired(record, now))
  // Like forget --source: preview unless --yes is present, and --dry-run always
  // wins so an explicit dry-run can never write even with --yes.
  const dryRun = values["dry-run"] === true || values.yes !== true

  let deleted = 0
  if (!dryRun) {
    for (const record of matches) {
      await stores.store.delete(record.id)
      deleted += 1
    }
  }

  console.log(JSON.stringify({ matched: matches.length, deleted, dryRun }, null, 2))
}

async function commandForget(values: CliValues): Promise<void> {
  if (values.id !== undefined && values.source !== undefined) {
    throw new Error("forget accepts either --id or --source, not both")
  }
  if (values.id !== undefined) {
    await commandForgetById(values, values.id)
    return
  }
  if (values.source !== undefined) {
    await commandForgetBySource(values, values.source)
    return
  }

  const ownerId = requireOwner(values)
  const stores = await loadStores(values)
  const projectId = await resolveProjectId(stores, values)
  if (values["dry-run"]) {
    const scope = projectId
      ? { scope: "project" as const, ownerId, projectId }
      : { scope: "user" as const, ownerId }
    const records = await stores.store.listAll()
    const matched = records.filter((record) => recordMatchesScope(record, scope)).length
    console.log(
      JSON.stringify(
        { matched, deleted: 0, scope: projectId ? "project" : "user", dryRun: true },
        null,
        2,
      ),
    )
    return
  }
  if (!values.yes) {
    throw new Error("refusing to delete memory without --yes")
  }
  const service = createService(stores, values, projectId)
  const deleted = await service.forget({
    ownerId,
    ...(projectId === undefined ? {} : { projectId }),
  })
  console.log(JSON.stringify({ deleted, scope: projectId ? "project" : "user" }, null, 2))
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE)
    return
  }

  if (command === "version" || command === "--version") {
    if (argv.slice(1).includes("--json")) {
      console.log(JSON.stringify({ name: "agent-rag", version: VERSION }))
    } else {
      console.log(VERSION)
    }
    return
  }

  const commonOptions = {
    "data-dir": { type: "string" as const },
    store: { type: "string" as const },
    owner: { type: "string" as const },
    user: { type: "string" as const },
    project: { type: "string" as const },
    "project-id": { type: "string" as const },
    client: { type: "string" as const },
    host: { type: "string" as const },
    port: { type: "string" as const },
    token: { type: "string" as const },
    remote: { type: "string" as const },
    "remote-url": { type: "string" as const },
    path: { type: "string" as const },
    name: { type: "string" as const },
    goal: { type: "string" as const },
    text: { type: "string" as const },
    title: { type: "string" as const },
    scope: { type: "string" as const },
    limit: { type: "string" as const },
    "max-chars": { type: "string" as const },
    "min-confidence": { type: "string" as const },
    sensitivity: { type: "string" as const },
    tag: { type: "string" as const, multiple: true as const },
    "include-expired": { type: "boolean" as const },
    "include-sensitive": { type: "boolean" as const },
    "by-kind": { type: "boolean" as const },
    "by-source": { type: "boolean" as const },
    out: { type: "string" as const },
    in: { type: "string" as const },
    id: { type: "string" as const },
    source: { type: "string" as const },
    force: { type: "boolean" as const },
    expired: { type: "boolean" as const },
    "dry-run": { type: "boolean" as const },
    yes: { type: "boolean" as const },
    help: { type: "boolean" as const },
  }

  // recall accepts repeatable --kind filters; remember keeps its single value
  // (repeating it still resolves to the last value, as before).
  const options =
    command === "recall"
      ? { ...commonOptions, kind: { type: "string" as const, multiple: true as const } }
      : { ...commonOptions, kind: { type: "string" as const } }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options,
  })

  if (values.help) {
    console.log(USAGE)
    return
  }

  const cliValues = values as CliValues
  switch (command) {
    case "serve":
      await commandServe(cliValues)
      return
    case "mcp":
      await commandMcp(cliValues)
      return
    case "resolve":
      await commandResolve(cliValues)
      return
    case "stats":
      await commandStats(cliValues)
      return
    case "export":
      await commandExport(cliValues)
      return
    case "import":
      await commandImport(cliValues)
      return
    case "recall":
      await commandRecall(cliValues, positionals)
      return
    case "inject":
      await commandInject(cliValues, positionals)
      return
    case "remember":
      await commandRemember(cliValues)
      return
    case "forget":
      await commandForget(cliValues)
      return
    case "purge":
      await commandPurge(cliValues)
      return
    default:
      throw new Error(`unknown command: ${command}\n\n${USAGE}`)
  }
}

main().catch((error: unknown) => {
  console.error(`[agent-rag] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
