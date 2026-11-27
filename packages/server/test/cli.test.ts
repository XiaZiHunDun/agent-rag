import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

function runCli(...args: readonly string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", cliPath, ...args], {
    encoding: "utf8",
  })
}

test("version subcommand prints the package version", () => {
  const result = runCli("version")
  assert.equal(result.status, 0)
  assert.match(result.stdout, /\b0\.1\.0\b/)
})

test("--version prints the package version", () => {
  const result = runCli("--version")
  assert.equal(result.status, 0)
  assert.match(result.stdout, /\b0\.1\.0\b/)
})

test("unknown command exits non-zero", () => {
  const result = runCli("definitely-not-a-command")
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unknown command/)
})

test("stats includes byKind only when --by-kind is passed", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-stats-"))
  try {
    const dataDir = join(dir, "data")
    const seeds = [
      ["note", "A", "alpha"],
      ["note", "B", "beta"],
      ["decision", "C", "gamma"],
    ] as const
    for (const [kind, title, text] of seeds) {
      const result = runCli(
        "remember",
        "--data-dir",
        dataDir,
        "--owner",
        "user-1",
        "--kind",
        kind,
        "--title",
        title,
        "--text",
        text,
      )
      assert.equal(result.status, 0, result.stderr)
    }

    const plain = runCli("stats", "--data-dir", dataDir)
    assert.equal(plain.status, 0, plain.stderr)
    const plainStats = JSON.parse(plain.stdout) as {
      total: number
      byScope: Record<string, number>
      byKind?: unknown
    }
    assert.equal(plainStats.total, 3)
    assert.equal(plainStats.byKind, undefined)
    assert.ok(Object.keys(plainStats.byScope).length > 0)

    const detailed = runCli("stats", "--data-dir", dataDir, "--by-kind")
    assert.equal(detailed.status, 0, detailed.stderr)
    const detailedStats = JSON.parse(detailed.stdout) as {
      total: number
      byKind?: Record<string, number>
    }
    assert.equal(detailedStats.total, 3)
    assert.deepEqual(detailedStats.byKind, { note: 2, decision: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolve --path reuses the project identity of its git remote", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-rag-cli-resolve-"))
  try {
    const repo = join(dir, "repo")
    mkdirSync(join(repo, ".git"), { recursive: true })
    writeFileSync(
      join(repo, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:owner/repo.git\n`,
    )
    const dataDir = join(dir, "data")
    const byPath = runCli("resolve", "--path", repo, "--data-dir", dataDir)
    const byRemote = runCli(
      "resolve",
      "--remote-url",
      "https://github.com/owner/repo",
      "--data-dir",
      dataDir,
    )

    assert.equal(byPath.status, 0)
    assert.equal(byRemote.status, 0)
    const pathIdentity = JSON.parse(byPath.stdout) as { projectId: string; key: string }
    const remoteIdentity = JSON.parse(byRemote.stdout) as { projectId: string }
    assert.equal(pathIdentity.key, "git:github.com/owner/repo")
    assert.equal(pathIdentity.projectId, remoteIdentity.projectId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
