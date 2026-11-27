import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import type { MemoryRecord } from "@agent-rag/core"

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

function runCli(...args: readonly string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", cliPath, ...args], {
    encoding: "utf8",
  })
}

function remember(dataDir: string, args: readonly string[]): MemoryRecord {
  const result = runCli("remember", "--data-dir", dataDir, ...args)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as MemoryRecord
}

function readJsonl(path: string): MemoryRecord[] {
  const raw = readFileSync(path, "utf8")
  if (raw.length === 0) return []
  return raw
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as MemoryRecord)
}

function seed(dataDir: string): { user: MemoryRecord; project: MemoryRecord } {
  const user = remember(dataDir, [
    "--owner",
    "user-1",
    "--scope",
    "user",
    "--kind",
    "preference",
    "--title",
    "回复风格",
    "--text",
    "先结论，后细节。",
    "--sensitivity",
    "secret",
  ])
  const project = remember(dataDir, [
    "--owner",
    "user-1",
    "--scope",
    "project",
    "--project-id",
    "proj-1",
    "--kind",
    "convention",
    "--title",
    "发布分支",
    "--text",
    "固定使用 release 分支。",
  ])
  return { user, project }
}

test("export writes user and project records as one-record-per-line JSONL", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-export-"))
  try {
    const dataDir = join(dir, "data")
    const { user, project } = seed(dataDir)
    const out = join(dir, "memory.jsonl")

    const result = runCli("export", "--data-dir", dataDir, "--out", out)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { exported: 2, out })

    const raw = readFileSync(out, "utf8")
    assert.ok(raw.endsWith("\n"), "JSONL file should end with a newline")
    const lines = raw.trimEnd().split("\n")
    assert.equal(lines.length, 2, "each record must occupy exactly one line")

    const records = lines.map((line) => JSON.parse(line) as MemoryRecord)
    assert.deepEqual(
      records.map((record) => record.scope).sort(),
      ["project", "user"],
    )
    assert.equal(records.find((record) => record.id === user.id)?.sensitivity, "secret")
    assert.equal(records.find((record) => record.id === project.id)?.projectId, "proj-1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("import is idempotent by id and round-trips the exact export", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-import-"))
  try {
    const sourceDir = join(dir, "source")
    seed(sourceDir)
    const sourceFile = join(dir, "source.jsonl")
    const exported = runCli("export", "--data-dir", sourceDir, "--out", sourceFile)
    assert.equal(exported.status, 0, exported.stderr)
    const original = readFileSync(sourceFile, "utf8")

    const targetDir = join(dir, "target")
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const imported = runCli("import", "--data-dir", targetDir, "--in", sourceFile)
      assert.equal(imported.status, 0, imported.stderr)
      assert.deepEqual(JSON.parse(imported.stdout), { imported: 2, in: sourceFile })
    }

    const stats = runCli("stats", "--data-dir", targetDir)
    assert.equal(stats.status, 0, stats.stderr)
    assert.equal((JSON.parse(stats.stdout) as { total: number }).total, 2)

    const reExportedFile = join(dir, "target.jsonl")
    const reExported = runCli("export", "--data-dir", targetDir, "--out", reExportedFile)
    assert.equal(reExported.status, 0, reExported.stderr)
    assert.equal(readFileSync(reExportedFile, "utf8"), original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("invalid JSONL aborts the whole import and reports the line number", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-import-invalid-"))
  try {
    const sourceDir = join(dir, "source")
    seed(sourceDir)
    const sourceFile = join(dir, "source.jsonl")
    const exported = runCli("export", "--data-dir", sourceDir, "--out", sourceFile)
    assert.equal(exported.status, 0, exported.stderr)
    const [validLine] = readFileSync(sourceFile, "utf8").trimEnd().split("\n")

    const malformedFile = join(dir, "malformed.jsonl")
    writeFileSync(malformedFile, `${validLine}\n{not json}\n`, "utf8")
    const malformedDir = join(dir, "malformed-target")
    remember(malformedDir, [
      "--owner",
      "user-1",
      "--kind",
      "note",
      "--title",
      "baseline",
      "--text",
      "keep me",
    ])
    const malformed = runCli("import", "--data-dir", malformedDir, "--in", malformedFile)
    assert.notEqual(malformed.status, 0)
    assert.match(malformed.stderr, /第 2 行: /)

    const invalidRecordFile = join(dir, "invalid-record.jsonl")
    writeFileSync(invalidRecordFile, `${validLine}\n{"id":"broken"}\n`, "utf8")
    const invalidDir = join(dir, "invalid-target")
    remember(invalidDir, [
      "--owner",
      "user-1",
      "--kind",
      "note",
      "--title",
      "baseline",
      "--text",
      "keep me",
    ])
    const invalid = runCli("import", "--data-dir", invalidDir, "--in", invalidRecordFile)
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /第 2 行: /)

    for (const dataDir of [malformedDir, invalidDir]) {
      const stats = runCli("stats", "--data-dir", dataDir)
      assert.equal(stats.status, 0, stats.stderr)
      assert.equal((JSON.parse(stats.stdout) as { total: number }).total, 1)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("export refuses to overwrite unless --force is passed", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-force-"))
  try {
    const dataDir = join(dir, "data")
    remember(dataDir, [
      "--owner",
      "user-1",
      "--kind",
      "note",
      "--title",
      "first",
      "--text",
      "first record",
    ])
    const out = join(dir, "memory.jsonl")
    const first = runCli("export", "--data-dir", dataDir, "--out", out)
    assert.equal(first.status, 0, first.stderr)
    const original = readFileSync(out, "utf8")
    assert.equal(original.trimEnd().split("\n").length, 1)

    remember(dataDir, [
      "--owner",
      "user-1",
      "--kind",
      "note",
      "--title",
      "second",
      "--text",
      "second record",
    ])

    const refused = runCli("export", "--data-dir", dataDir, "--out", out)
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /refusing to overwrite existing file/)
    assert.equal(readFileSync(out, "utf8"), original, "existing file must stay untouched")

    const forced = runCli("export", "--data-dir", dataDir, "--out", out, "--force")
    assert.equal(forced.status, 0, forced.stderr)
    assert.equal(readJsonl(out).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
