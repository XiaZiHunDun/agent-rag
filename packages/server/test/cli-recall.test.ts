import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import type { MemoryHit, MemoryRecord } from "@agent-rag/core"

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

function runCli(...args: readonly string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", cliPath, ...args], {
    encoding: "utf8",
  })
}

function record(
  id: string,
  kind: MemoryRecord["kind"],
  title: string,
  text: string,
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    id,
    schemaVersion: 1,
    scope: "user",
    ownerId: "user-1",
    kind,
    title,
    text,
    source: { kind: "manual", ref: `test:${id}`, client: "cli" },
    confidence: 0.8,
    sensitivity: "normal",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

/** Seed the JSON store directly so records can carry confidence/expiry/sensitivity. */
function seed(dataDir: string, records: readonly MemoryRecord[]): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(dataDir, "memory.json"),
    `${JSON.stringify({ version: 1, records }, null, 2)}\n`,
    "utf8",
  )
}

function recallIds(dataDir: string, ...args: readonly string[]): string[] {
  const result = runCli("recall", "--data-dir", dataDir, "--owner", "user-1", ...args)
  assert.equal(result.status, 0, result.stderr)
  const hits = JSON.parse(result.stdout) as MemoryHit[]
  return hits.map((hit) => hit.record.id).sort()
}

test("recall filters by one or more --kind values", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-recall-kind-"))
  try {
    const dataDir = join(dir, "data")
    seed(dataDir, [
      record("mem-convention", "convention", "发布约定", "发布使用 release 分支"),
      record("mem-decision", "decision", "发布决策", "发布前跑全量测试"),
      record("mem-note", "note", "发布备注", "发布后通知"),
    ])

    assert.deepEqual(recallIds(dataDir, "--kind", "convention", "发布"), ["mem-convention"])
    assert.deepEqual(recallIds(dataDir, "--kind", "convention", "--kind", "decision", "发布"), [
      "mem-convention",
      "mem-decision",
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("recall filters by one or more --tag values", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-recall-tag-"))
  try {
    const dataDir = join(dir, "data")
    seed(dataDir, [
      record("mem-release", "convention", "发布", "使用 release 分支", { tags: ["release"] }),
      record("mem-gateway", "decision", "网关", "超时 30s", { tags: ["gateway"] }),
      record("mem-untagged", "note", "备注", "没有标签"),
    ])

    assert.deepEqual(recallIds(dataDir, "--tag", "release"), ["mem-release"])
    assert.deepEqual(recallIds(dataDir, "--tag", "release", "--tag", "gateway"), [
      "mem-gateway",
      "mem-release",
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("recall filters by --min-confidence including the boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-recall-confidence-"))
  try {
    const dataDir = join(dir, "data")
    seed(dataDir, [
      record("mem-high", "note", "高置信", "高", { confidence: 0.9 }),
      record("mem-boundary", "note", "边界", "边界", { confidence: 0.5 }),
      record("mem-low", "note", "低置信", "低", { confidence: 0.4 }),
    ])

    assert.deepEqual(recallIds(dataDir, "--min-confidence", "0.5"), [
      "mem-boundary",
      "mem-high",
    ])
    assert.deepEqual(recallIds(dataDir, "--min-confidence", "0.9"), ["mem-high"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("recall excludes expired records unless --include-expired is passed", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-recall-expired-"))
  try {
    const dataDir = join(dir, "data")
    seed(dataDir, [
      record("mem-expired", "note", "旧约定", "已经过期", {
        validFrom: "2019-01-01T00:00:00.000Z",
        validTo: "2020-01-01T00:00:00.000Z",
      }),
      record("mem-active", "note", "现行约定", "仍然有效"),
    ])

    assert.deepEqual(recallIds(dataDir), ["mem-active"])
    assert.deepEqual(recallIds(dataDir, "--include-expired"), ["mem-active", "mem-expired"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("recall excludes secret records unless --include-sensitive is passed", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-recall-sensitive-"))
  try {
    const dataDir = join(dir, "data")
    seed(dataDir, [
      record("mem-secret", "preference", "私密偏好", "不要外传", { sensitivity: "secret" }),
      record("mem-private", "preference", "普通偏好", "可以召回", { sensitivity: "private" }),
    ])

    assert.deepEqual(recallIds(dataDir), ["mem-private"])
    assert.deepEqual(recallIds(dataDir, "--include-sensitive"), ["mem-private", "mem-secret"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("recall rejects invalid filter arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-recall-invalid-"))
  try {
    const dataDir = join(dir, "data")
    seed(dataDir, [record("mem-note", "note", "备注", "内容")])

    const invalidConfidence = ["1.5", "-0.1", "not-a-number"]
    for (const value of invalidConfidence) {
      const result = runCli(
        "recall",
        "--data-dir",
        dataDir,
        "--owner",
        "user-1",
        `--min-confidence=${value}`,
      )
      assert.notEqual(result.status, 0, `--min-confidence ${value} should fail`)
      assert.match(result.stderr, /invalid --min-confidence/)
    }

    const invalidKind = runCli(
      "recall",
      "--data-dir",
      dataDir,
      "--owner",
      "user-1",
      "--kind",
      "not-a-kind",
    )
    assert.notEqual(invalidKind.status, 0)
    assert.match(invalidKind.stderr, /invalid --kind/)

    const emptyTag = runCli("recall", "--data-dir", dataDir, "--owner", "user-1", "--tag", "")
    assert.notEqual(emptyTag.status, 0)
    assert.match(emptyTag.stderr, /invalid --tag/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("remember keeps single-valued --kind semantics", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-remember-kind-"))
  try {
    const dataDir = join(dir, "data")
    const result = runCli(
      "remember",
      "--data-dir",
      dataDir,
      "--owner",
      "user-1",
      "--kind",
      "note",
      "--kind",
      "decision",
      "--title",
      "发布决策",
      "--text",
      "发布前跑全量测试",
    )

    assert.equal(result.status, 0, result.stderr)
    const stored = JSON.parse(result.stdout) as MemoryRecord
    assert.equal(stored.kind, "decision")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
