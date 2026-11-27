import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildMemoryContext,
  createMemoryRecord,
  type MemoryHit,
  type MemoryRecord,
} from "../src/index.ts"

function makeHit(record: MemoryRecord, score = 1): MemoryHit {
  return { record, score, matchedTerms: [] }
}

const profile = createMemoryRecord({
  scope: "user",
  ownerId: "user-1",
  kind: "preference",
  title: "回复风格",
  text: "先结论，后细节。",
  source: { kind: "manual", ref: "manual:test:1" },
  createdAt: "2026-11-27T00:00:00.000Z",
  updatedAt: "2026-11-27T00:00:00.000Z",
})

const convention = createMemoryRecord({
  scope: "project",
  ownerId: "user-1",
  projectId: "prj_1",
  kind: "convention",
  title: "发布分支",
  text: "固定使用 release 分支。",
  source: { kind: "task_result", ref: "task-1", client: "wfxm" },
  createdAt: "2026-11-27T00:00:00.000Z",
  updatedAt: "2026-11-27T00:00:00.000Z",
})

test("renders user and project sections with kind labels", () => {
  const result = buildMemoryContext({
    user: [makeHit(profile)],
    project: [makeHit(convention)],
  })

  assert.ok(result.text.startsWith("<agent-rag-memory>"))
  assert.ok(result.text.includes("## 用户记忆"))
  assert.ok(result.text.includes("## 项目记忆"))
  assert.ok(result.text.includes("[偏好] 回复风格：先结论，后细节。"))
  assert.ok(result.text.includes("[约定] 发布分支：固定使用 release 分支。"))
  assert.equal(result.entries.length, 2)
  assert.equal(result.truncated, false)
  assert.ok(result.usedChars > 0)
})

test("empty input yields an empty block", () => {
  const result = buildMemoryContext({})
  assert.equal(result.text, "")
  assert.deepEqual(result.entries, [])
  assert.equal(result.truncated, false)
})

test("dedupes records by checksum across sections", () => {
  const duplicate = { ...profile, id: "another-id" }
  const result = buildMemoryContext({ user: [makeHit(profile), makeHit(duplicate)] })
  assert.equal(result.entries.length, 1)
})

test("respects the character budget and reports truncation", () => {
  const long = createMemoryRecord({
    scope: "user",
    ownerId: "user-1",
    kind: "note",
    title: "长记录",
    text: "很长的内容".repeat(100),
    source: { kind: "manual", ref: "manual:test:2" },
  })
  const result = buildMemoryContext({
    user: [makeHit(profile), makeHit(long), makeHit(convention)],
    maxChars: 200,
  })

  assert.equal(result.truncated, true)
  assert.ok(result.usedChars <= 400)
  assert.ok(result.text.length < 500)
})

test("single entries are clipped to the per-item limit", () => {
  const long = createMemoryRecord({
    scope: "user",
    ownerId: "user-1",
    kind: "note",
    title: "长记录",
    text: "内容".repeat(400),
    source: { kind: "manual", ref: "manual:test:3" },
  })
  const result = buildMemoryContext({ user: [makeHit(long)] })
  const entry = result.entries[0]
  assert.ok(entry)
  assert.ok(entry.text.length <= 500)
  assert.ok(entry.text.endsWith("…"))
})
