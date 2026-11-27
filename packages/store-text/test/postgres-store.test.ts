import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { PGlite } from "@electric-sql/pglite"
import { createMemoryRecord, type MemoryRecord } from "@agent-rag/core"
import { PostgresTextStore } from "../src/index.ts"

const userScope = { scope: "user" as const, ownerId: "user-1" }
const p1 = { scope: "project" as const, ownerId: "user-1", projectId: "proj-1" }
const p2 = { scope: "project" as const, ownerId: "user-1", projectId: "proj-2" }

let db: PGlite
let store: PostgresTextStore

beforeEach(async () => {
  db = new PGlite()
  store = await PostgresTextStore.open(db)
})

afterEach(async () => {
  await db.close()
})

function record(
  scope: typeof userScope | typeof p1,
  overrides: {
    id?: string
    title: string
    text: string
    kind?: MemoryRecord["kind"]
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
    source: { kind: "manual", ref: `test:${overrides.title}` },
    ...(overrides.tags === undefined ? {} : { tags: overrides.tags }),
    ...(overrides.sensitivity === undefined ? {} : { sensitivity: overrides.sensitivity }),
    ...(overrides.confidence === undefined ? {} : { confidence: overrides.confidence }),
    ...(overrides.validTo === undefined ? {} : { validTo: overrides.validTo }),
    ...(overrides.updatedAt === undefined ? {} : { updatedAt: overrides.updatedAt }),
  })
}

test("round-trips a record through Postgres", async () => {
  const original = record(p1, { id: "a", title: "端口配置", text: "端口来自 PORT 环境变量。", tags: ["config"] })
  await store.upsert(original)
  const loaded = await store.get("a")
  assert.equal(loaded?.id, "a")
  assert.equal(loaded?.title, "端口配置")
  assert.deepEqual(loaded?.tags, ["config"])
  assert.deepEqual(loaded?.facts, {})

  const all = await store.listAll()
  assert.equal(all.length, 1)
  assert.equal(all[0]?.id, "a")
})

test("searches Chinese and keeps project scope isolated", async () => {
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

test("applies kind, tag, confidence, expiry and sensitivity filters", async () => {
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

  const withExpired = await store.search({ scope: p1, text: "部署", includeExpired: true, limit: 10 })
  assert.ok(withExpired.some((hit) => hit.record.title === "过期决策"))

  const withoutSecret = await store.search({ scope: p1, text: "部署", limit: 10 })
  assert.ok(!withoutSecret.some((hit) => hit.record.title === "密钥备注"))
  const withSecret = await store.search({ scope: p1, text: "部署", includeSensitive: true, limit: 10 })
  assert.ok(withSecret.some((hit) => hit.record.title === "密钥备注"))
})

test("upsert replaces and deleteScope removes only the target project", async () => {
  const first = record(p1, { id: "mem-1", title: "端口", text: "端口是 3000。" })
  await store.upsert(first)
  await store.upsert(
    record(p1, { id: "mem-1", title: "端口", text: "端口改为 8080。", updatedAt: "2026-11-17T00:00:00Z" }),
  )
  assert.equal((await store.search({ scope: p1, text: "3000", limit: 10 })).length, 0)
  assert.equal((await store.search({ scope: p1, text: "8080", limit: 10 })).length, 1)

  await store.upsert(record(p2, { id: "mem-2", title: "端口", text: "8080 端口。" }))
  const deleted = await store.deleteScope(p1)
  assert.equal(deleted, 1)
  assert.equal((await store.stats()).total, 1)
  assert.equal((await store.search({ scope: p2, text: "8080", limit: 10 })).length, 1)
})

test("empty query returns recent records and stats group scopes and kinds", async () => {
  await store.upsertMany([
    record(p1, { title: "旧记录", text: "x", updatedAt: "2026-01-01T00:00:00Z", kind: "note" }),
    record(p1, { title: "新记录", text: "y", updatedAt: "2026-11-01T00:00:00Z", kind: "decision" }),
    record(userScope, { title: "用户偏好", text: "先结论后细节。", kind: "preference" }),
  ])
  const hits = await store.search({ scope: p1, text: "", limit: 10 })
  assert.deepEqual(hits.map((hit) => hit.record.title), ["新记录", "旧记录"])

  const stats = await store.stats()
  assert.equal(stats.total, 3)
  assert.deepEqual(Object.values(stats.byScope).sort(), [1, 2])
  assert.deepEqual(stats.byKind, { note: 1, decision: 1, preference: 1 })
})
