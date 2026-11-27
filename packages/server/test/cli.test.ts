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

test("version --json prints name and version as JSON", () => {
  const result = runCli("version", "--json")
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(result.stdout), { name: "agent-rag", version: "0.1.0" })
})

test("unknown command exits non-zero", () => {
  const result = runCli("definitely-not-a-command")
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unknown command/)
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
