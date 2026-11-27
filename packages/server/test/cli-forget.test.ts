import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import {
  createMemoryRecord,
  type MemoryRecord,
  type MemorySource,
  type MemoryScope,
} from "@agent-rag/core"
import { JsonTextStore } from "@agent-rag/store-text"

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const createdAt = "2026-01-01T00:00:00.000Z"

function runCli(...args: readonly string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", cliPath, ...args], {
    encoding: "utf8",
  })
}

interface SeedInput {
  readonly id: string
  readonly scope: MemoryScope
  readonly ownerId: string
  readonly projectId?: string
  readonly source: MemorySource
}

function seedRecord(input: SeedInput): MemoryRecord {
  return createMemoryRecord({
    id: input.id,
    scope: input.scope,
    ownerId: input.ownerId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    kind: "note",
    title: input.id,
    text: `memory ${input.id}`,
    source: input.source,
    createdAt,
    updatedAt: createdAt,
  })
}

function mixedRecords(): readonly MemoryRecord[] {
  return [
    seedRecord({
      id: "user-target",
      scope: "user",
      ownerId: "user-1",
      source: { kind: "task_result", ref: "task-1", client: "wfxm" },
    }),
    seedRecord({
      id: "project-target",
      scope: "project",
      ownerId: "user-1",
      projectId: "proj-1",
      source: { kind: "butler_session", ref: "session-1", client: "wfxm" },
    }),
    seedRecord({
      id: "other-source",
      scope: "user",
      ownerId: "user-1",
      source: { kind: "task_result", ref: "task-2", client: "dsh-wfxm" },
    }),
    seedRecord({
      id: "manual-no-client",
      scope: "project",
      ownerId: "user-1",
      projectId: "proj-1",
      source: { kind: "manual", ref: "manual:user-1:1" },
    }),
  ]
}

async function seed(dataDir: string, records: readonly MemoryRecord[]): Promise<void> {
  const store = await JsonTextStore.open(join(dataDir, "memory.json"))
  await store.upsertMany(records)
}

async function storedIds(dataDir: string): Promise<string[]> {
  const store = await JsonTextStore.open(join(dataDir, "memory.json"))
  return (await store.listAll()).map((record) => record.id).sort()
}

function memoryFile(dataDir: string): string {
  return join(dataDir, "memory.json")
}

test("forget --id deletes exactly one record and keeps every other record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-forget-id-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, mixedRecords())

    const result = runCli("forget", "--data-dir", dataDir, "--id", "user-target", "--yes")
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      id: "user-target",
      matched: 1,
      deleted: 1,
      dryRun: false,
    })
    assert.deepEqual(await storedIds(dataDir), [
      "manual-no-client",
      "other-source",
      "project-target",
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("forget --id with an unknown id prints a message and exits 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-forget-id-missing-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, mixedRecords())
    const before = readFileSync(memoryFile(dataDir), "utf8")

    const result = runCli("forget", "--data-dir", dataDir, "--id", "missing-id", "--yes")
    assert.equal(result.status, 1)
    assert.match(result.stderr, /memory not found: missing-id/)
    assert.equal(readFileSync(memoryFile(dataDir), "utf8"), before)
    assert.deepEqual(await storedIds(dataDir), [
      "manual-no-client",
      "other-source",
      "project-target",
      "user-target",
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("forget --id without --yes previews and does not delete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-forget-id-preview-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, mixedRecords())
    const before = readFileSync(memoryFile(dataDir), "utf8")

    const result = runCli("forget", "--data-dir", dataDir, "--id", "project-target")
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      id: "project-target",
      matched: 1,
      deleted: 0,
      dryRun: true,
    })
    assert.equal(readFileSync(memoryFile(dataDir), "utf8"), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("forget --id --dry-run does not write even with --yes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-forget-id-dry-run-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, mixedRecords())
    const before = readFileSync(memoryFile(dataDir), "utf8")

    const result = runCli(
      "forget",
      "--data-dir",
      dataDir,
      "--id",
      "project-target",
      "--dry-run",
      "--yes",
    )
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      id: "project-target",
      matched: 1,
      deleted: 0,
      dryRun: true,
    })
    assert.equal(readFileSync(memoryFile(dataDir), "utf8"), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("forget rejects --id combined with --source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-forget-id-source-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, mixedRecords())
    const before = readFileSync(memoryFile(dataDir), "utf8")

    const result = runCli(
      "forget",
      "--data-dir",
      dataDir,
      "--id",
      "user-target",
      "--source",
      "wfxm",
      "--yes",
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /either --id or --source/)
    assert.equal(readFileSync(memoryFile(dataDir), "utf8"), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("forget --source deletes only matching source.client records across user and project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-forget-source-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, mixedRecords())

    const result = runCli(
      "forget",
      "--data-dir",
      dataDir,
      "--source",
      "wfxm",
      "--yes",
    )
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      source: "wfxm",
      matched: 2,
      deleted: 2,
      dryRun: false,
    })
    assert.deepEqual(await storedIds(dataDir), ["manual-no-client", "other-source"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("forget --source without --yes previews and does not delete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-forget-preview-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, mixedRecords())
    const before = readFileSync(memoryFile(dataDir), "utf8")

    const result = runCli("forget", "--data-dir", dataDir, "--source", "wfxm")
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout) as { matched: number; deleted: number }
    assert.equal(output.matched, 2)
    assert.equal(output.deleted, 0)
    assert.equal(readFileSync(memoryFile(dataDir), "utf8"), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("forget --source --dry-run does not write even with --yes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-forget-dry-run-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, mixedRecords())
    const before = readFileSync(memoryFile(dataDir), "utf8")

    const result = runCli(
      "forget",
      "--data-dir",
      dataDir,
      "--source",
      "wfxm",
      "--dry-run",
      "--yes",
    )
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      source: "wfxm",
      matched: 2,
      deleted: 0,
      dryRun: true,
    })
    assert.equal(readFileSync(memoryFile(dataDir), "utf8"), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("forget --source with no match prints zero and exits 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-forget-empty-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, mixedRecords())
    const before = readFileSync(memoryFile(dataDir), "utf8")

    const result = runCli(
      "forget",
      "--data-dir",
      dataDir,
      "--source",
      "missing-client",
      "--yes",
    )
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      source: "missing-client",
      matched: 0,
      deleted: 0,
      dryRun: false,
    })
    assert.equal(readFileSync(memoryFile(dataDir), "utf8"), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("forget --dry-run previews a whole scope without deleting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-forget-scope-dry-run-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, mixedRecords())
    const before = readFileSync(memoryFile(dataDir), "utf8")

    const result = runCli(
      "forget",
      "--data-dir",
      dataDir,
      "--owner",
      "user-1",
      "--project-id",
      "proj-1",
      "--dry-run",
      "--yes",
    )
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      matched: 2,
      deleted: 0,
      scope: "project",
      dryRun: true,
    })
    assert.equal(readFileSync(memoryFile(dataDir), "utf8"), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("forget without --source still deletes exactly one whole scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-forget-scope-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, mixedRecords())

    const project = runCli(
      "forget",
      "--data-dir",
      dataDir,
      "--owner",
      "user-1",
      "--project-id",
      "proj-1",
      "--yes",
    )
    assert.equal(project.status, 0, project.stderr)
    assert.deepEqual(JSON.parse(project.stdout), { deleted: 2, scope: "project" })
    assert.deepEqual(await storedIds(dataDir), ["other-source", "user-target"])

    const user = runCli("forget", "--data-dir", dataDir, "--owner", "user-1", "--yes")
    assert.equal(user.status, 0, user.stderr)
    assert.deepEqual(JSON.parse(user.stdout), { deleted: 2, scope: "user" })
    assert.deepEqual(await storedIds(dataDir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
