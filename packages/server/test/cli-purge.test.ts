import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { createMemoryRecord, type MemoryRecord, type MemoryScope } from "@agent-rag/core"
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
  readonly validTo?: string
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
    source: { kind: "manual", ref: `manual:${input.id}` },
    ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
    createdAt,
    updatedAt: createdAt,
  })
}

function mixedRecords(): readonly MemoryRecord[] {
  return [
    seedRecord({
      id: "expired-user",
      scope: "user",
      ownerId: "user-1",
      validTo: "2020-01-01T00:00:00.000Z",
    }),
    seedRecord({
      id: "expired-project",
      scope: "project",
      ownerId: "user-1",
      projectId: "proj-1",
      validTo: "2021-01-01T00:00:00.000Z",
    }),
    seedRecord({
      id: "future-user",
      scope: "user",
      ownerId: "user-1",
      validTo: "2999-01-01T00:00:00.000Z",
    }),
    seedRecord({
      id: "no-expiry-project",
      scope: "project",
      ownerId: "user-1",
      projectId: "proj-1",
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

test("purge --expired deletes expired records across user and project scopes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-purge-expired-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, mixedRecords())

    const result = runCli("purge", "--expired", "--data-dir", dataDir, "--yes")
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      matched: 2,
      deleted: 2,
      dryRun: false,
    })
    assert.deepEqual(await storedIds(dataDir), ["future-user", "no-expiry-project"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("purge --expired without --yes previews and does not delete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-purge-preview-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, mixedRecords())
    const before = readFileSync(memoryFile(dataDir), "utf8")

    const result = runCli("purge", "--expired", "--data-dir", dataDir)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      matched: 2,
      deleted: 0,
      dryRun: true,
    })
    assert.equal(readFileSync(memoryFile(dataDir), "utf8"), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("purge --expired --dry-run does not write even with --yes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-purge-dry-run-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, mixedRecords())
    const before = readFileSync(memoryFile(dataDir), "utf8")

    const result = runCli(
      "purge",
      "--expired",
      "--data-dir",
      dataDir,
      "--dry-run",
      "--yes",
    )
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      matched: 2,
      deleted: 0,
      dryRun: true,
    })
    assert.equal(readFileSync(memoryFile(dataDir), "utf8"), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("purge --expired with no match prints zero and exits 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-purge-empty-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, [
      seedRecord({
        id: "future-user",
        scope: "user",
        ownerId: "user-1",
        validTo: "2999-01-01T00:00:00.000Z",
      }),
      seedRecord({
        id: "no-expiry-project",
        scope: "project",
        ownerId: "user-1",
        projectId: "proj-1",
      }),
    ])
    const before = readFileSync(memoryFile(dataDir), "utf8")

    const result = runCli("purge", "--expired", "--data-dir", dataDir, "--yes")
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      matched: 0,
      deleted: 0,
      dryRun: false,
    })
    assert.equal(readFileSync(memoryFile(dataDir), "utf8"), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
