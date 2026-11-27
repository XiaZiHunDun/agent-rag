import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { JsonProjectRegistry } from "../src/index.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-rag-registry-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test("persists identities and reuses them after reopen", async () => {
  const file = join(dir, "projects.json")
  const registry = await JsonProjectRegistry.open(file)
  const created = await registry.resolve({
    remoteUrl: "git@github.com:XiaZiHunDun/agent-rag.git",
    localPath: "/home/user/wfxm-clone",
  })

  const reopened = await JsonProjectRegistry.open(file)
  const fromPath = await reopened.resolve({ localPath: "/home/user/wfxm-clone" })
  const fromRemote = await reopened.resolve({
    remoteUrl: "https://github.com/xiazihundun/agent-rag",
    localPath: "/home/user/another-clone",
  })

  assert.equal(fromPath.projectId, created.projectId)
  assert.equal(fromRemote.projectId, created.projectId)
  const snapshot = JSON.parse(readFileSync(file, "utf8")) as { version: number; identities: unknown[] }
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.identities.length, 1)
})

test("rejects an unsupported registry file", async () => {
  const file = join(dir, "projects.json")
  const { writeFileSync } = await import("node:fs")
  writeFileSync(file, JSON.stringify({ version: 2, identities: [] }))
  await assert.rejects(JsonProjectRegistry.open(file), /version must be 1/)
})
