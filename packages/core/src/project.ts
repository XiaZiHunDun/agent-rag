import { createHash } from "node:crypto"
import { basename, resolve as resolvePath } from "node:path"

/**
 * Project identity resolution.
 *
 * Different assistants may open the same repository from different clones or
 * with different display names. A ProjectRegistry converges these locators onto
 * one stable projectId, so project memory is shared across assistants.
 */

export interface ProjectLocator {
  /** Git remote, e.g. git@github.com:owner/repo.git or https://github.com/owner/repo */
  readonly remoteUrl?: string
  /** Absolute or relative local path to the repository. */
  readonly localPath?: string
  /** Human-readable project name, used as a weak alias. */
  readonly name?: string
}

export interface ProjectIdentity {
  /** Deterministic "prj_" + 16 hex derived from the canonical key. */
  readonly projectId: string
  /** Canonical alias, e.g. "git:github.com/owner/repo". */
  readonly key: string
  readonly name?: string
  readonly remoteUrl?: string
  readonly aliases: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export class ProjectIdentityError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`invalid project locator: ${issues.join("; ")}`)
    this.name = "ProjectIdentityError"
    this.issues = issues
  }
}

/** Hosts whose repository paths are case-insensitive. */
const CASE_INSENSITIVE_HOSTS = new Set([
  "github.com",
  "gitee.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
])

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function isDefaultPort(protocol: string, port: string): boolean {
  if (!port) return true
  return (
    (protocol === "ssh:" && port === "22") ||
    (protocol === "https:" && port === "443") ||
    (protocol === "http:" && port === "80") ||
    (protocol === "git:" && port === "9418")
  )
}

function stripGitSuffix(value: string): string {
  let path = value.replace(/\/+$/, "")
  if (path.toLowerCase().endsWith(".git")) path = path.slice(0, -4)
  return path.replace(/^\/+/, "").replace(/\/+$/, "")
}

/**
 * Normalize a git remote to "host/owner/repo".
 * Drops userinfo, default ports, trailing slashes and the optional .git suffix.
 */
export function normalizeRemoteUrl(raw: string): string {
  const value = raw.trim()
  if (!value) throw new ProjectIdentityError(["remoteUrl must not be empty"])

  let host = ""
  let path = ""

  if (value.includes("://")) {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new ProjectIdentityError([`cannot parse remoteUrl: ${value}`])
    }
    host = parsed.hostname.toLowerCase()
    if (parsed.port && !isDefaultPort(parsed.protocol, parsed.port)) {
      host = `${host}:${parsed.port}`
    }
    path = decodeURIComponent(parsed.pathname)
  } else {
    // scp-like syntax: [user@]host:path
    const match = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value)
    if (!match) throw new ProjectIdentityError([`cannot parse remoteUrl: ${value}`])
    host = (match[1] as string).toLowerCase()
    path = match[2] as string
  }

  path = stripGitSuffix(path)
  if (!host || !path) throw new ProjectIdentityError([`cannot parse remoteUrl: ${value}`])

  const normalizedPath = CASE_INSENSITIVE_HOSTS.has(host) ? path.toLowerCase() : path
  return `${host}/${normalizedPath}`
}

export function normalizeLocalPath(raw: string): string {
  const value = raw.trim()
  if (!value) throw new ProjectIdentityError(["localPath must not be empty"])
  return resolvePath(value).replace(/\\/g, "/").replace(/(.+)\/+$/, "$1")
}

/**
 * Aliases in priority order. The first alias is used as the canonical key when
 * the project is first registered.
 */
export function projectAliases(locator: ProjectLocator): readonly string[] {
  const aliases: string[] = []
  if (locator.remoteUrl?.trim()) aliases.push(`git:${normalizeRemoteUrl(locator.remoteUrl)}`)
  if (locator.localPath?.trim()) aliases.push(`path:${normalizeLocalPath(locator.localPath)}`)
  if (locator.name?.trim()) aliases.push(`name:${locator.name.trim().toLowerCase()}`)
  return [...new Set(aliases)]
}

export function projectIdFromKey(key: string): string {
  return `prj_${sha(key).slice(0, 16)}`
}

function nameFromKey(key: string): string | undefined {
  const normalized = key.replace(/\/+$/, "")
  const segment = normalized.slice(normalized.lastIndexOf("/") + 1)
  return segment || basename(normalized) || undefined
}

function validateIdentity(value: unknown, index: number): readonly string[] {
  if (typeof value !== "object" || value === null) return [`identities[${index}] must be an object`]
  const identity = value as Partial<ProjectIdentity>
  const issues: string[] = []
  if (typeof identity.projectId !== "string" || !identity.projectId) {
    issues.push(`identities[${index}].projectId is required`)
  }
  if (typeof identity.key !== "string" || !identity.key) {
    issues.push(`identities[${index}].key is required`)
  }
  if (!Array.isArray(identity.aliases) || identity.aliases.length === 0) {
    issues.push(`identities[${index}].aliases must be a non-empty array`)
  }
  if (typeof identity.createdAt !== "string" || typeof identity.updatedAt !== "string") {
    issues.push(`identities[${index}] must have createdAt and updatedAt`)
  }
  return issues
}

export interface ProjectRegistry {
  resolve(locator: ProjectLocator): Promise<ProjectIdentity>
  get(projectId: string): Promise<ProjectIdentity | null>
  list(): Promise<readonly ProjectIdentity[]>
}

export interface ProjectRegistryOptions {
  readonly now?: () => string
}

/**
 * In-memory registry; persistence lives in @agent-rag/store-text's
 * JsonProjectRegistry, which reuses the resolution rules below.
 */
export class InMemoryProjectRegistry implements ProjectRegistry {
  protected readonly identities = new Map<string, ProjectIdentity>()
  protected readonly aliasIndex = new Map<string, string>()
  private readonly now: () => string

  constructor(options: ProjectRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async resolve(locator: ProjectLocator): Promise<ProjectIdentity> {
    const aliases = projectAliases(locator)
    if (aliases.length === 0) {
      throw new ProjectIdentityError(["project locator requires remoteUrl, localPath, or name"])
    }

    // The strongest locator provided is authoritative: remote > path > name.
    // Weaker aliases are only merged when they are not already owned elsewhere,
    // so two repositories sharing a basename never collapse into one project.
    const primary = aliases[0] as string
    const matchedProjectId = this.aliasIndex.get(primary)
    if (matchedProjectId) {
      const current = this.identities.get(matchedProjectId) as ProjectIdentity
      const extra = aliases.filter((alias) => !this.aliasIndex.has(alias))
      if (extra.length === 0) return current

      for (const alias of extra) this.aliasIndex.set(alias, matchedProjectId)
      const updated: ProjectIdentity = {
        ...current,
        aliases: [...current.aliases, ...extra],
        updatedAt: this.now(),
      }
      this.identities.set(matchedProjectId, updated)
      await this.persist()
      return updated
    }

    const key = primary
    const projectId = projectIdFromKey(key)
    const existing = this.identities.get(projectId)
    if (existing) return existing

    // First binding wins: never steal an alias that another project owns.
    const ownedAliases = aliases.filter((alias) => !this.aliasIndex.has(alias))
    const timestamp = this.now()
    const identity: ProjectIdentity = {
      projectId,
      key,
      ...(locationName(locator, key) === undefined ? {} : { name: locationName(locator, key) }),
      ...(locator.remoteUrl?.trim() ? { remoteUrl: locator.remoteUrl.trim() } : {}),
      aliases: ownedAliases,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.identities.set(projectId, identity)
    for (const alias of ownedAliases) this.aliasIndex.set(alias, projectId)
    await this.persist()
    return identity
  }

  async get(projectId: string): Promise<ProjectIdentity | null> {
    return this.identities.get(projectId) ?? null
  }

  async list(): Promise<readonly ProjectIdentity[]> {
    return [...this.identities.values()].sort((a, b) => a.projectId.localeCompare(b.projectId))
  }

  /** Serialize the registry for persistence. */
  snapshot(): readonly ProjectIdentity[] {
    return [...this.identities.values()].sort((a, b) => a.projectId.localeCompare(b.projectId))
  }

  /** Load a persisted snapshot; subclasses call this from their open(). */
  protected load(identities: readonly ProjectIdentity[]): void {
    for (const identity of identities) {
      this.identities.set(identity.projectId, identity)
      for (const alias of identity.aliases) this.aliasIndex.set(alias, identity.projectId)
    }
  }

  /** No-op for the in-memory implementation. */
  protected async persist(): Promise<void> {}

  static validateSnapshot(value: unknown): readonly string[] {
    if (typeof value !== "object" || value === null) return ["snapshot must be an object"]
    const snapshot = value as { version?: unknown; identities?: unknown }
    const issues: string[] = []
    if (snapshot.version !== 1) issues.push("snapshot.version must be 1")
    if (!Array.isArray(snapshot.identities)) {
      issues.push("snapshot.identities must be an array")
    } else {
      for (const [index, item] of snapshot.identities.entries()) {
        issues.push(...validateIdentity(item, index))
      }
    }
    return issues
  }
}

function locationName(locator: ProjectLocator, key: string): string | undefined {
  if (locator.name?.trim()) return locator.name.trim()
  return nameFromKey(key)
}
