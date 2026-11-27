import { lstat, readFile } from "node:fs/promises"
import { join, resolve as resolvePath } from "node:path"
import type { ProjectLocator } from "@agent-rag/core"

function remoteFromConfig(config: string): string | undefined {
  const sections = config.matchAll(/\[remote\s+"([^"]+)"\]([\s\S]*?)(?=\n\[|$)/g)
  let first: string | undefined
  for (const [, name, body] of sections) {
    const url = /^\s*url\s*=\s*(.+)$/m.exec(body ?? "")
    if (!url) continue
    const value = (url[1] as string).trim()
    if (!value) continue
    if (name === "origin") return value
    first ??= value
  }
  return first
}

/**
 * Read the git remote URL of a local working tree.
 *
 * Supports regular repositories and `git worktree` (where `.git` is a file
 * pointing at the real git dir). Returns undefined for non-repositories.
 */
export async function discoverGitRemote(localPath: string): Promise<string | undefined> {
  let gitDir = join(resolvePath(localPath), ".git")
  const entry = await lstat(gitDir).catch(() => null)
  if (!entry) return undefined

  if (entry.isFile()) {
    const pointer = await readFile(gitDir, "utf8").catch(() => "")
    const match = /^gitdir:\s*(.+)$/m.exec(pointer)
    if (!match) return undefined
    gitDir = resolvePath(resolvePath(localPath), match[1]!.trim())
  }

  const config = await readFile(join(gitDir, "config"), "utf8").catch(() => "")
  return remoteFromConfig(config)
}

/**
 * Fill in the git remote when only a local path is given, so a repository is
 * resolved to the same projectId regardless of which clone the assistant uses.
 */
export async function enrichProjectLocator(locator: ProjectLocator): Promise<ProjectLocator> {
  if (locator.remoteUrl?.trim() || !locator.localPath?.trim()) return locator
  const remoteUrl = await discoverGitRemote(locator.localPath)
  return remoteUrl === undefined ? locator : { ...locator, remoteUrl }
}
