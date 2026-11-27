import assert from "node:assert/strict"
import { test } from "node:test"
import {
  MemoryValidationError,
  createMemoryRecord,
  memoryChecksum,
  stableMemoryId,
  validateMemoryRecord,
} from "../src/index.ts"

const base = {
  scope: "user" as const,
  ownerId: "user-1",
  kind: "preference" as const,
  title: "沟通偏好",
  text: "用户偏好先给结论，再给细节。",
  source: { kind: "butler_session" as const, ref: "session-1" },
}

test("creates a validated user-scope record with defaults", () => {
  const record = createMemoryRecord(base)
  assert.equal(record.scope, "user")
  assert.equal(record.projectId, undefined)
  assert.equal(record.confidence, 0.8)
  assert.equal(record.sensitivity, "normal")
  assert.equal(record.schemaVersion, 1)
  assert.ok(record.checksum)
  assert.deepEqual(validateMemoryRecord(record), [])
})

test("project scope requires projectId, user scope forbids it", () => {
  assert.throws(
    () => createMemoryRecord({ ...base, scope: "project" }),
    (error: unknown) =>
      error instanceof MemoryValidationError &&
      error.issues.some((issue) => issue.includes("projectId is required")),
  )
  assert.throws(
    () => createMemoryRecord({ ...base, projectId: "p-1" }),
    (error: unknown) =>
      error instanceof MemoryValidationError &&
      error.issues.some((issue) => issue.includes("must be omitted for user scope")),
  )
})

test("rejects invalid confidence, dates and kinds", () => {
  assert.throws(
    () => createMemoryRecord({ ...base, confidence: 1.4 }),
    (error: unknown) => error instanceof MemoryValidationError,
  )
  assert.throws(
    () =>
      createMemoryRecord({
        ...base,
        validFrom: "2026-01-02T00:00:00Z",
        validTo: "2026-01-01T00:00:00Z",
      }),
    (error: unknown) => error instanceof MemoryValidationError,
  )
  const invalid = { ...createMemoryRecord(base), kind: "unknown" }
  assert.ok(validateMemoryRecord(invalid).some((issue) => issue.includes("kind")))
})

test("stable ids are deterministic across source versions", () => {
  const input = {
    scope: "project" as const,
    ownerId: "user-1",
    projectId: "proj-1",
    kind: "decision" as const,
    source: { kind: "pi_session" as const, ref: "task-1" },
  }
  const first = stableMemoryId(input)
  const second = stableMemoryId({
    ...input,
    source: { ...input.source, version: "v2" },
  })
  assert.equal(first, second)
  assert.notEqual(
    first,
    stableMemoryId({ ...input, projectId: "proj-2" }),
  )
})

test("checksum changes with canonical content", () => {
  const first = memoryChecksum({ title: "A", text: "one" })
  const second = memoryChecksum({ title: "A", text: "two" })
  assert.notEqual(first, second)
  assert.equal(first, memoryChecksum({ title: "A", text: "one" }))
})
