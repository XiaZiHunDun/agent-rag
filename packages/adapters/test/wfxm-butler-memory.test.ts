import assert from "node:assert/strict"
import { test } from "node:test"
import { AgentRagClient } from "@agent-rag/client"
import { InMemoryProjectionCheckpointStore } from "@agent-rag/core"
import { InMemoryTextStore } from "@agent-rag/store-text"
import { createWfxmButlerMemory } from "../src/index.ts"

function setup(ownerId = "user-1") {
  const store = new InMemoryTextStore()
  const client = new AgentRagClient({
    store,
    checkpointStore: new InMemoryProjectionCheckpointStore(),
  })
  const memory = createWfxmButlerMemory({
    client,
    ownerId,
    clock: () => "2026-11-17T10:00:00Z",
  })
  return { store, memory }
}

const userScope = (ownerId = "user-1") => ({ scope: "user" as const, ownerId })

test("projects a session summary into user-scope memory", async () => {
  const { memory, store } = setup()
  await memory.recordSessionSummary({
    userId: "user-1",
    sessionId: "s1",
    summary: "用户要求以后用要点回答。",
    profile: { communicationStyle: "要点式", preferences: ["先结论后细节"] },
    facts: [
      { kind: "convention", title: "发布分支", text: "发布分支固定为 release。" },
    ],
  })

  const hits = await store.search({ scope: userScope(), text: "要点" })
  assert.ok(hits.length >= 1)
  assert.ok(hits.every((hit) => hit.record.scope === "user"))
  assert.ok(hits.some((hit) => hit.record.kind === "profile"))

  const facts = await store.search({ scope: userScope(), text: "发布分支" })
  assert.ok(facts.some((hit) => hit.record.kind === "convention"))
})

test("recalls user memory through the butler port", async () => {
  const { memory } = setup()
  await memory.recordSessionSummary({
    userId: "user-1",
    sessionId: "s1",
    summary: "用户偏好要点式回答。",
    profile: { communicationStyle: "要点式" },
  })

  const recalled = await memory.recallUserMemory("回答风格", 3)
  assert.ok(recalled.length >= 1)
  assert.ok(recalled.every((item) => item.title && item.text))
})

test("updates the same profile across sessions instead of duplicating", async () => {
  const { memory, store } = setup()
  await memory.recordSessionSummary({
    userId: "user-1",
    sessionId: "s1",
    summary: "第一轮：用户喜欢简短回复。",
    profile: { communicationStyle: "简短" },
    occurredAt: "2026-11-17T10:00:00Z",
  })
  await memory.recordSessionSummary({
    userId: "user-1",
    sessionId: "s2",
    summary: "第二轮：用户改为要点式回复。",
    profile: { communicationStyle: "要点式" },
    occurredAt: "2026-11-17T11:00:00Z",
  })

  const hits = await store.search({ scope: userScope(), text: "回复", kinds: ["profile"] })
  assert.equal(hits.length, 1)
  assert.match(hits[0]?.record.text ?? "", /要点式/)
})

test("keeps user memory isolated between owners", async () => {
  const { memory, store } = setup()
  await memory.recordSessionSummary({
    userId: "user-1",
    sessionId: "s1",
    summary: "用户偏好要点式回答。",
    profile: { communicationStyle: "要点式" },
  })

  const other = await store.search({ scope: userScope("user-2"), text: "要点" })
  assert.equal(other.length, 0)
})

test("writes nothing when the summary has no durable content", async () => {
  const { memory, store } = setup()
  await memory.recordSessionSummary({
    userId: "user-1",
    sessionId: "s1",
    summary: "",
  })
  const stats = await store.stats()
  assert.equal(stats.total, 0)
})
