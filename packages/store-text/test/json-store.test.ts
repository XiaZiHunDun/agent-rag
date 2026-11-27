import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { createMemoryRecord, type MemoryRecord } from "@agent-rag/core"
import { JsonTextStore } from "../src/index.ts"

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-rag-"))
  file = join(dir, "memory.json")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function record(id: string, title: string, text: string, kind: MemoryRecord["kind"] = "note") {
  return createMemoryRecord({
    id,
    scope: "project",
    ownerId: "user-1",
    projectId: "proj-1",
    kind,
    title,
    text,
    source: { kind: "manual", ref: `test:${id}` },
  })
}

test("persists records and reloads the search index", async () => {
  const first = await JsonTextStore.open(file)
  await first.upsertMany([
    record("a", "端口配置", "端口来自 PORT 环境变量。"),
    record("b", "构建命令", "使用 pnpm test。"),
  ])
  assert.equal((await first.stats()).total, 2)

  const second = await JsonTextStore.open(file)
  assert.equal((await second.stats()).total, 2)
  assert.equal((await second.listAll()).length, 2)
  const hits = await second.search({
    scope: { scope: "project", ownerId: "user-1", projectId: "proj-1" },
    text: "端口",
    limit: 5,
  })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.record.id, "a")
})

test("deleteScope persists the removal", async () => {
  const store = await JsonTextStore.open(file)
  await store.upsertMany([record("a", "A", "alpha"), record("b", "B", "beta")])
  const deleted = await store.deleteScope({
    scope: "project",
    ownerId: "user-1",
    projectId: "proj-1",
  })
  assert.equal(deleted, 2)

  const reopened = await JsonTextStore.open(file)
  assert.equal((await reopened.stats()).total, 0)
})

test("stats count records by kind and source after reload", async () => {
  const store = await JsonTextStore.open(file)
  await store.upsertMany([
    record("a", "A", "alpha", "note"),
    record("b", "B", "beta", "decision"),
    record("c", "C", "gamma", "decision"),
  ])

  const stats = await (await JsonTextStore.open(file)).stats()
  assert.equal(stats.total, 3)
  assert.deepEqual(stats.byKind, { note: 1, decision: 2 })
  assert.deepEqual(stats.bySource, { unknown: 3 })
})
