import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { InMemoryProjectRegistry } from "@agent-rag/core"
import { InMemoryTextStore } from "@agent-rag/store-text"
import { discoverGitRemote, enrichProjectLocator } from "../src/project-discovery.ts"
import { AgentRagService } from "../src/service.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-rag-git-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeRepo(path: string, remote: string): void {
  mkdirSync(join(path, ".git"), { recursive: true })
  writeFileSync(
    join(path, ".git", "config"),
    `[core]\n\trepositoryformatversion = 0\n[remote "upstream"]\n\turl = ${remote}\n[remote "origin"]\n\turl = ${remote}\n`,
  )
}

test("reads the origin remote from a local repository", async () => {
  const repo = join(dir, "clone")
  makeRepo(repo, "git@github.com:XiaZiHunDun/agent-rag.git")
  assert.equal(await discoverGitRemote(repo), "git@github.com:XiaZiHunDun/agent-rag.git")
  assert.equal(await discoverGitRemote(join(dir, "missing")), undefined)
})

test("resolves a path-only locator to the same project as its remote", async () => {
  const repo = join(dir, "clone")
  makeRepo(repo, "git@github.com:XiaZiHunDun/agent-rag.git")

  const service = new AgentRagService({
    store: new InMemoryTextStore(),
    registry: new InMemoryProjectRegistry(),
    defaultOwnerId: "user-1",
  })
  const byPath = await service.resolveProject({ localPath: repo })
  const byRemote = await service.resolveProject({
    remoteUrl: "https://github.com/xiazihundun/agent-rag",
  })
  assert.equal(byPath.projectId, byRemote.projectId)
  assert.ok(byPath.aliases.some((alias) => alias.startsWith("git:")))
})

test("enrichment leaves explicit remotes and non-repositories untouched", async () => {
  const explicit = { remoteUrl: "git@github.com:o/r.git", localPath: dir }
  assert.equal(await enrichProjectLocator(explicit), explicit)

  const plain = { localPath: dir }
  const enriched = await enrichProjectLocator(plain)
  assert.equal(enriched.remoteUrl, undefined)
})

test("supports git worktree pointer files", async () => {
  const commonGit = join(dir, "main", ".git")
  mkdirSync(commonGit, { recursive: true })
  writeFileSync(
    join(commonGit, "config"),
    `[remote "origin"]\n\turl = https://github.com/o/worktree-repo.git\n`,
  )
  // A linked worktree keeps HEAD/index in its own gitdir and points at the
  // shared config through `commondir`.
  const worktreeGitDir = join(commonGit, "worktrees", "wt")
  mkdirSync(worktreeGitDir, { recursive: true })
  writeFileSync(join(worktreeGitDir, "commondir"), "../..\n")
  const worktree = join(dir, "worktree")
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`)

  assert.equal(
    await discoverGitRemote(worktree),
    "https://github.com/o/worktree-repo.git",
  )
})
