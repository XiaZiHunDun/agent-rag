import assert from "node:assert/strict"
import { test } from "node:test"
import {
  InMemoryProjectRegistry,
  ProjectIdentityError,
  normalizeLocalPath,
  normalizeRemoteUrl,
  projectAliases,
  projectIdFromKey,
} from "../src/index.ts"

test("normalizes common git remote forms to one key", () => {
  const forms = [
    "git@github.com:XiaZiHunDun/agent-rag.git",
    "https://github.com/xiazihundun/agent-rag",
    "https://github.com/XiaZiHunDun/agent-rag.git/",
    "ssh://git@github.com:22/xiazihundun/agent-rag.git",
    "git://github.com/xiazihundun/agent-rag",
  ]
  for (const form of forms) {
    assert.equal(normalizeRemoteUrl(form), "github.com/xiazihundun/agent-rag", form)
  }
})

test("keeps path case on case-sensitive hosts", () => {
  assert.equal(
    normalizeRemoteUrl("git@git.example.com:Team/Repo.git"),
    "git.example.com/Team/Repo",
  )
})

test("rejects empty and unparseable locators", async () => {
  assert.throws(() => normalizeRemoteUrl("  "), ProjectIdentityError)
  const registry = new InMemoryProjectRegistry()
  await assert.rejects(registry.resolve({}), ProjectIdentityError)
})

test("different clones of the same remote share one projectId", async () => {
  const registry = new InMemoryProjectRegistry({ now: () => "2026-11-27T00:00:00.000Z" })
  const wfxm = await registry.resolve({
    remoteUrl: "git@github.com:XiaZiHunDun/agent-rag.git",
    localPath: "/home/user/wfxm-clone",
  })
  const dsh = await registry.resolve({
    remoteUrl: "https://github.com/xiazihundun/agent-rag",
    localPath: "/home/user/projects/agent-rag",
    name: "Agent RAG",
  })

  assert.equal(wfxm.projectId, dsh.projectId)
  assert.equal(wfxm.key, "git:github.com/xiazihundun/agent-rag")
  assert.equal(dsh.name, "agent-rag")
  assert.ok(dsh.aliases.includes(`path:${normalizeLocalPath("/home/user/projects/agent-rag")}`))
  assert.ok(dsh.aliases.includes("name:agent rag"))
})

test("projectId is deterministic and stable across registry instances", () => {
  const key = "git:github.com/xiazihundun/agent-rag"
  assert.equal(projectIdFromKey(key), projectIdFromKey(key))
  assert.match(projectIdFromKey(key), /^prj_[0-9a-f]{16}$/)
  assert.notEqual(projectIdFromKey(key), projectIdFromKey(`${key}-other`))
})

test("first alias binding wins when a name is already registered", async () => {
  const registry = new InMemoryProjectRegistry()
  const byName = await registry.resolve({ name: "agent-rag" })
  const byRemote = await registry.resolve({
    remoteUrl: "git@github.com:someone/agent-rag.git",
    name: "agent-rag",
  })

  assert.notEqual(byName.projectId, byRemote.projectId)
  assert.equal((await registry.resolve({ name: "agent-rag" })).projectId, byName.projectId)
  assert.equal((await registry.list()).length, 2)
})

test("local path aliases are absolute and reuse the identity", async () => {
  const registry = new InMemoryProjectRegistry()
  const first = await registry.resolve({ localPath: "packages/core" })
  const second = await registry.resolve({ localPath: "packages/core/../core" })
  assert.equal(first.projectId, second.projectId)
  assert.ok(projectAliases({ localPath: "packages/core" })[0]?.startsWith("path:/"))

  const local = await registry.resolve({ name: "core" })
  assert.notEqual(local.projectId, first.projectId)
})
