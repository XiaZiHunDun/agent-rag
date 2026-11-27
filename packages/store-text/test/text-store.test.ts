import assert from "node:assert/strict"
import { test } from "node:test"
import { createMemoryRecord, type MemoryRecord } from "@agent-rag/core"
import { InMemoryTextStore } from "../src/index.ts"

const userScope = { scope: "user" as const, ownerId: "user-1" }
const p1 = { scope: "project" as const, ownerId: "user-1", projectId: "proj-1" }
const p2 = { scope: "project" as const, ownerId: "user-1", projectId: "proj-2" }

function record(
  scope: typeof userScope | typeof p1,
  overrides: {
    id?: string
    title: string
    text: string
    kind?: MemoryRecord["kind"]
    client?: string
    tags?: readonly string[]
    sensitivity?: MemoryRecord["sensitivity"]
    confidence?: number
    validTo?: string
    updatedAt?: string
  },
): MemoryRecord {
  return createMemoryRecord({
    ...(overrides.id === undefined ? {} : { id: overrides.id }),
    scope: scope.scope,
    ownerId: scope.ownerId,
    ...("projectId" in scope ? { projectId: scope.projectId } : {}),
    kind: overrides.kind ?? "note",
    title: overrides.title,
    text: overrides.text,
    source: {
      kind: "manual",
      ref: `test:${overrides.title}`,
      ...(overrides.client === undefined ? {} : { client: overrides.client }),
    },
    ...(overrides.tags === undefined ? {} : { tags: overrides.tags }),
    ...(overrides.sensitivity === undefined ? {} : { sensitivity: overrides.sensitivity }),
    ...(overrides.confidence === undefined ? {} : { confidence: overrides.confidence }),
    ...(overrides.validTo === undefined ? {} : { validTo: overrides.validTo }),
    ...(overrides.updatedAt === undefined ? {} : { updatedAt: overrides.updatedAt }),
  })
}

test("retrieves Chinese text inside the requested project only", async () => {
  const store = new InMemoryTextStore()
  await store.upsertMany([
    record(p1, { title: "端口配置来源", text: "端口来自 PORT 环境变量，默认 3000。", tags: ["config"] }),
    record(p1, { title: "构建命令", text: "使用 pnpm test 运行测试。" }),
    record(p2, { title: "端口配置", text: "另一个项目使用 8080 端口。" }),
  ])

  const hits = await store.search({ scope: p1, text: "端口", limit: 5 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.record.title, "端口配置来源")
  assert.ok((hits[0]?.score ?? 0) > 0)

  const other = await store.search({ scope: p2, text: "端口", limit: 5 })
  assert.equal(other.length, 1)
  assert.equal(other[0]?.record.title, "端口配置")
})

test("isolates user scope from project scope", async () => {
  const store = new InMemoryTextStore()
  await store.upsertMany([
    record(userScope, { title: "沟通偏好", text: "先结论后细节。" }),
    record(p1, { title: "项目约定", text: "提交前运行 pnpm test。" }),
  ])

  const user = await store.search({ scope: userScope, text: "", limit: 10 })
  assert.deepEqual(user.map((hit) => hit.record.title), ["沟通偏好"])

  const project = await store.search({ scope: p1, text: "", limit: 10 })
  assert.deepEqual(project.map((hit) => hit.record.title), ["项目约定"])
})

test("applies kind, tag, confidence, expiry and sensitivity filters", async () => {
  const store = new InMemoryTextStore()
  await store.upsertMany([
    record(p1, { title: "部署决策", text: "部署到 A 区。", kind: "decision", tags: ["deploy"], confidence: 0.9 }),
    record(p1, { title: "过期决策", text: "部署到 B 区。", kind: "decision", validTo: "2020-01-01T00:00:00Z" }),
    record(p1, { title: "密钥备注", text: "部署密钥是 sk-test。", sensitivity: "secret" }),
    record(p1, { title: "低置信笔记", text: "部署可能用 C 区。", confidence: 0.2 }),
  ])

  const decisions = await store.search({ scope: p1, text: "部署", kinds: ["decision"], limit: 10 })
  assert.deepEqual(decisions.map((hit) => hit.record.title), ["部署决策"])

  const tagged = await store.search({ scope: p1, text: "部署", tags: ["deploy"], limit: 10 })
  assert.deepEqual(tagged.map((hit) => hit.record.title), ["部署决策"])

  const confident = await store.search({ scope: p1, text: "部署", minConfidence: 0.5, limit: 10 })
  assert.ok(confident.every((hit) => hit.record.confidence >= 0.5))

  const withExpired = await store.search({ scope: p1, text: "部署", includeExpired: true, limit: 10 })
  assert.ok(withExpired.some((hit) => hit.record.title === "过期决策"))

  const withSecret = await store.search({ scope: p1, text: "部署", includeSensitive: true, limit: 10 })
  assert.ok(withSecret.some((hit) => hit.record.title === "密钥备注"))
  const withoutSecret = await store.search({ scope: p1, text: "部署", limit: 10 })
  assert.ok(!withoutSecret.some((hit) => hit.record.title === "密钥备注"))
})

test("empty query returns recent records in scope", async () => {
  const store = new InMemoryTextStore()
  await store.upsertMany([
    record(p1, { title: "旧记录", text: "x", updatedAt: "2026-01-01T00:00:00Z" }),
    record(p1, { title: "新记录", text: "y", updatedAt: "2026-11-01T00:00:00Z" }),
  ])
  const hits = await store.search({ scope: p1, text: "", limit: 10 })
  assert.deepEqual(hits.map((hit) => hit.record.title), ["新记录", "旧记录"])
})

test("upserting the same id replaces indexed content", async () => {
  const store = new InMemoryTextStore()
  const first = record(p1, { id: "mem-1", title: "端口", text: "端口是 3000。" })
  await store.upsert(first)

  const second = record(p1, {
    id: "mem-1",
    title: "端口",
    text: "端口改为 8080。",
    updatedAt: "2026-11-17T00:00:00Z",
  })
  await store.upsert(second)

  const oldHits = await store.search({ scope: p1, text: "3000", limit: 10 })
  assert.equal(oldHits.length, 0)
  const newHits = await store.search({ scope: p1, text: "8080", limit: 10 })
  assert.equal(newHits.length, 1)
  assert.equal((await store.stats()).total, 1)
})

test("delete and deleteScope remove records and index entries", async () => {
  const store = new InMemoryTextStore()
  const a = record(p1, { id: "a", title: "A", text: "alpha" })
  const b = record(p1, { id: "b", title: "B", text: "beta" })
  const other = record(p2, { id: "c", title: "C", text: "gamma" })
  await store.upsertMany([a, b, other])

  await store.delete("a")
  assert.equal(await store.get("a"), null)
  assert.equal((await store.get("b"))?.id, "b")
  assert.equal((await store.get("c"))?.id, "c")
  assert.equal((await store.search({ scope: p1, text: "alpha", limit: 10 })).length, 0)

  const deleted = await store.deleteScope(p1)
  assert.equal(deleted, 1)
  assert.equal((await store.stats()).total, 1)
  assert.equal((await store.search({ scope: p2, text: "gamma", limit: 10 })).length, 1)
})

test("stats group records by full scope key, kind and source client", async () => {
  const store = new InMemoryTextStore()
  await store.upsertMany([
    record(userScope, { title: "U", text: "u", kind: "preference", client: "wfxm" }),
    record(p1, { title: "P1", text: "p1", kind: "note", client: "wfxm" }),
    record(p1, { title: "P1b", text: "p1b", kind: "decision" }),
  ])
  const stats = await store.stats()
  assert.equal(stats.total, 3)
  assert.deepEqual(Object.values(stats.byScope).sort(), [1, 2])
  assert.deepEqual(stats.byKind, { preference: 1, note: 1, decision: 1 })
  assert.deepEqual(stats.bySource, { wfxm: 2, unknown: 1 })
})

test("listAll returns every scope including secret records, sorted by id", async () => {
  const store = new InMemoryTextStore()
  await store.upsertMany([
    record(userScope, { id: "u", title: "U", text: "u", sensitivity: "secret" }),
    record(p1, { id: "p", title: "P", text: "p" }),
  ])
  const all = await store.listAll()
  assert.deepEqual(
    all.map((item) => item.id),
    ["p", "u"],
  )
  assert.equal(all.find((item) => item.id === "u")?.sensitivity, "secret")
})
