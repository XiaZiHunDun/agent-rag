import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { createMemoryRecord, type MemoryRecord, type MemorySource } from "@agent-rag/core"
import { JsonTextStore } from "@agent-rag/store-text"

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const createdAt = "2026-01-01T00:00:00.000Z"

function runCli(...args: readonly string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", cliPath, ...args], {
    encoding: "utf8",
  })
}

function seedRecord(input: {
  readonly id: string
  readonly projectId?: string
  readonly source: MemorySource
}): MemoryRecord {
  return createMemoryRecord({
    id: input.id,
    scope: input.projectId === undefined ? "user" : "project",
    ownerId: "user-1",
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    kind: "note",
    title: input.id,
    text: `memory ${input.id}`,
    source: input.source,
    createdAt,
    updatedAt: createdAt,
  })
}

async function seed(dataDir: string, records: readonly MemoryRecord[]): Promise<void> {
  const store = await JsonTextStore.open(join(dataDir, "memory.json"))
  await store.upsertMany(records)
}

test("stats --by-source counts two clients plus unknown across scopes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-stats-source-"))
  try {
    const dataDir = join(dir, "data")
    await seed(dataDir, [
      seedRecord({
        id: "user-wfxm",
        source: { kind: "task_result", ref: "task-1", client: "wfxm" },
      }),
      seedRecord({
        id: "project-wfxm",
        projectId: "proj-1",
        source: { kind: "butler_session", ref: "session-1", client: "wfxm" },
      }),
      seedRecord({
        id: "project-dsh",
        projectId: "proj-1",
        source: { kind: "task_result", ref: "task-2", client: "dsh-wfxm" },
      }),
      seedRecord({
        id: "no-client",
        source: { kind: "manual", ref: "manual:user-1:1" },
      }),
    ])

    const plain = runCli("stats", "--data-dir", dataDir)
    assert.equal(plain.status, 0, plain.stderr)
    const plainStats = JSON.parse(plain.stdout) as { bySource?: unknown }
    assert.equal(plainStats.bySource, undefined)

    const bySource = runCli("stats", "--data-dir", dataDir, "--by-source")
    assert.equal(bySource.status, 0, bySource.stderr)
    const sourceStats = JSON.parse(bySource.stdout) as {
      total: number
      bySource?: Record<string, number>
      byKind?: unknown
    }
    assert.equal(sourceStats.total, 4)
    assert.deepEqual(sourceStats.bySource, { wfxm: 2, "dsh-wfxm": 1, unknown: 1 })
    assert.equal(sourceStats.byKind, undefined)

    const combined = runCli("stats", "--data-dir", dataDir, "--by-kind", "--by-source")
    assert.equal(combined.status, 0, combined.stderr)
    const combinedStats = JSON.parse(combined.stdout) as {
      total: number
      byKind?: Record<string, number>
      bySource?: Record<string, number>
    }
    assert.equal(combinedStats.total, 4)
    assert.deepEqual(combinedStats.byKind, { note: 4 })
    assert.deepEqual(combinedStats.bySource, { wfxm: 2, "dsh-wfxm": 1, unknown: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("stats --by-source reports zero counts on an empty store", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-stats-source-empty-"))
  try {
    const dataDir = join(dir, "data")
    const result = runCli("stats", "--data-dir", dataDir, "--by-source")
    assert.equal(result.status, 0, result.stderr)
    const stats = JSON.parse(result.stdout) as {
      total: number
      byScope: Record<string, number>
      bySource?: Record<string, number>
    }
    assert.equal(stats.total, 0)
    assert.deepEqual(stats.byScope, {})
    assert.deepEqual(stats.bySource, {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
