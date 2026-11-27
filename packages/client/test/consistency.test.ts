import assert from "node:assert/strict"
import { test } from "node:test"
import {
  MemoryValidationError,
  createMemoryRecord,
  type ProjectionEvent,
  type Projector,
} from "@agent-rag/core"
import { InMemoryTextStore } from "@agent-rag/store-text"
import { AgentRagClient } from "../src/index.ts"

const projectScope = {
  scope: "project" as const,
  ownerId: "user-1",
  projectId: "proj-1",
}

const createdAt = "2026-01-01T00:00:00.000Z"

function memory(overrides: {
  readonly text: string
  readonly kind?: "convention" | "decision" | "preference"
  readonly supersedes?: readonly string[]
  readonly validFrom?: string
  readonly scope?: "user" | "project"
}) {
  const isUser = overrides.scope === "user"
  return createMemoryRecord({
    scope: overrides.scope ?? "project",
    ownerId: "user-1",
    ...(isUser ? {} : { projectId: "proj-1" }),
    kind: overrides.kind ?? "convention",
    title: "测试框架",
    text: overrides.text,
    source: { kind: "manual", ref: overrides.text },
    ...(overrides.supersedes === undefined ? {} : { supersedes: overrides.supersedes }),
    ...(overrides.validFrom === undefined ? {} : { validFrom: overrides.validFrom }),
    createdAt,
    updatedAt: createdAt,
  })
}

test("superseding a record retires the old one from default recall", async () => {
  const client = new AgentRagClient({ store: new InMemoryTextStore() })
  const old = memory({ text: "测试框架使用 Jest" })
  await client.remember(old)

  const replacement = memory({
    text: "测试框架使用 Vitest",
    supersedes: [old.id],
    validFrom: "2026-06-01T00:00:00.000Z",
  })
  const retired = await client.remember(replacement)

  assert.deepEqual(retired, [old.id])
  assert.equal((await client.get(old.id))?.validTo, "2026-06-01T00:00:00.000Z")

  const hits = await client.recall({ scope: projectScope, text: "测试框架" })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.record.id, replacement.id)
  assert.equal(hits[0]?.record.text, "测试框架使用 Vitest")

  const withExpired = await client.recall({
    scope: projectScope,
    text: "测试框架",
    includeExpired: true,
  })
  assert.equal(withExpired.length, 2)
})

test("superseding across scopes is rejected", async () => {
  const client = new AgentRagClient({ store: new InMemoryTextStore() })
  const old = memory({ text: "用户偏好中文", scope: "user", kind: "preference" })
  await client.remember(old)

  const replacement = memory({
    text: "项目约定用英文提交信息",
    scope: "project",
    supersedes: [old.id],
  })

  await assert.rejects(
    () => client.remember(replacement),
    (error: unknown) =>
      error instanceof MemoryValidationError && /outside scope/.test(error.message),
  )
  // The new record is still written; the old scope keeps its own validity.
  assert.equal((await client.get(old.id))?.validTo, undefined)
})

test("missing supersede targets are ignored", async () => {
  const client = new AgentRagClient({ store: new InMemoryTextStore() })
  const record = memory({ text: "测试框架使用 Vitest", supersedes: ["missing-id"] })
  const retired = await client.remember(record)
  assert.deepEqual(retired, [])
})

test("projected records also retire their superseded predecessors", async () => {
  const client = new AgentRagClient({ store: new InMemoryTextStore() })
  const old = memory({ text: "测试框架使用 Jest" })
  await client.remember(old)

  const replacement = memory({
    text: "测试框架使用 Vitest",
    supersedes: [old.id],
    validFrom: "2026-06-01T00:00:00.000Z",
  })
  const projector: Projector = {
    name: "manual-replacement",
    sourceKind: "manual",
    supports: () => true,
    project: () => [replacement],
  }
  client.register(projector)

  const event: ProjectionEvent = {
    id: "event-1",
    type: "manual.write",
    occurredAt: "2026-06-01T00:00:00.000Z",
    source: { kind: "manual", ref: "event-1" },
    payload: {},
  }
  const report = await client.project("manual-replacement", [event], {
    scope: projectScope,
    now: "2026-06-01T00:00:00.000Z",
  })

  assert.equal(report.written, 1)
  assert.equal((await client.get(old.id))?.validTo, "2026-06-01T00:00:00.000Z")
  const hits = await client.recall({ scope: projectScope, text: "测试框架" })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.record.id, replacement.id)
})
