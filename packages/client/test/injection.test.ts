import assert from "node:assert/strict"
import { test } from "node:test"
import { createMemoryRecord } from "@agent-rag/core"
import { InMemoryTextStore } from "@agent-rag/store-text"
import { collectInjection } from "../src/injection.ts"

const context = {
  createdAt: "2026-11-27T00:00:00.000Z",
  updatedAt: "2026-11-27T00:00:00.000Z",
}

async function seed(): Promise<InMemoryTextStore> {
  const store = new InMemoryTextStore()
  await store.upsertMany([
    createMemoryRecord({
      scope: "user",
      ownerId: "user-1",
      kind: "preference",
      title: "回复风格",
      text: "先结论，后细节。",
      source: { kind: "manual", ref: "m1", client: "wfxm" },
      ...context,
    }),
    createMemoryRecord({
      scope: "user",
      ownerId: "user-1",
      kind: "commitment",
      title: "本周目标",
      text: "只做稳定性修复。",
      source: { kind: "manual", ref: "m2" },
      ...context,
    }),
    createMemoryRecord({
      scope: "project",
      ownerId: "user-1",
      projectId: "prj_1",
      kind: "convention",
      title: "发布分支",
      text: "固定使用 release 分支。",
      source: { kind: "task_result", ref: "t1", client: "wfxm" },
      ...context,
    }),
    createMemoryRecord({
      scope: "project",
      ownerId: "user-1",
      projectId: "prj_1",
      kind: "note",
      title: "数据库口令",
      text: "secret-value-should-not-leak",
      sensitivity: "secret",
      source: { kind: "manual", ref: "m3" },
      ...context,
    }),
    createMemoryRecord({
      scope: "project",
      ownerId: "user-1",
      projectId: "prj_2",
      kind: "convention",
      title: "其他项目",
      text: "不应召回。",
      source: { kind: "manual", ref: "m4" },
      ...context,
    }),
  ])
  return store
}

test("pins user profile and retrieves project memory for a goal", async () => {
  const store = await seed()
  const result = await collectInjection(store, {
    ownerId: "user-1",
    projectId: "prj_1",
    goal: "发布分支怎么走",
  })

  assert.ok(result.userHits.some((hit) => hit.record.kind === "preference"))
  assert.ok(result.userHits.some((hit) => hit.record.kind === "commitment"))
  assert.ok(result.projectHits.some((hit) => hit.record.title === "发布分支"))
  assert.ok(result.projectHits.every((hit) => hit.record.projectId === "prj_1"))
  assert.ok(!result.projectHits.some((hit) => hit.record.title === "其他项目"))
  assert.ok(!result.text.includes("secret-value-should-not-leak"))
  assert.ok(result.text.includes("## 用户记忆"))
  assert.ok(result.text.includes("## 项目记忆"))
})

test("works without a project and still injects the pinned profile", async () => {
  const store = await seed()
  const result = await collectInjection(store, { ownerId: "user-1", goal: "" })
  assert.ok(result.userHits.length >= 2)
  assert.deepEqual(result.projectHits, [])
  assert.ok(result.text.includes("## 用户记忆"))
  assert.ok(!result.text.includes("## 项目记忆"))
})

test("returns an empty block for an unknown user", async () => {
  const store = await seed()
  const result = await collectInjection(store, { ownerId: "nobody", goal: "发布" })
  assert.equal(result.text, "")
  assert.equal(result.entries.length, 0)
})
