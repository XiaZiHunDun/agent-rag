import assert from "node:assert/strict"
import { test } from "node:test"
import type { ProjectionContext, ProjectionEvent } from "@agent-rag/core"
import { ButlerSessionProjector } from "../src/index.ts"

const context: ProjectionContext = {
  scope: { scope: "user", ownerId: "user-1" },
  now: "2026-11-17T10:00:00Z",
}

function event(overrides: Partial<ProjectionEvent> = {}): ProjectionEvent {
  return {
    id: "event-1",
    type: "butler.session.summarized",
    occurredAt: "2026-11-17T10:00:00Z",
    source: { kind: "butler_session", ref: "session-1" },
    payload: {
      userId: "user-1",
      sessionId: "session-1",
      summary: "用户确认了发布分支约定。",
      profile: {
        displayName: "老王",
        communicationStyle: "先结论后细节",
        preferences: ["用要点回答", "避免长段落"],
        commitments: ["周五前给发布计划"],
        relationships: [{ name: "小李", relation: "同事", notes: "负责测试" }],
      },
      facts: [
        { title: "发布分支", text: "发布分支固定为 release。", kind: "convention", tags: ["release"] },
      ],
    },
    ...overrides,
  }
}

test("projects a butler session into a profile plus explicit facts", () => {
  const records = new ButlerSessionProjector().project(event(), context)
  assert.equal(records.length, 2)

  const profile = records.find((record) => record.kind === "profile")
  assert.equal(profile?.scope, "user")
  assert.equal(profile?.ownerId, "user-1")
  assert.equal(profile?.projectId, undefined)
  assert.match(profile?.text ?? "", /先结论后细节/)
  assert.match(profile?.text ?? "", /周五前给发布计划/)
  assert.equal(profile?.facts?.["displayName"], "老王")

  const fact = records.find((record) => record.kind === "convention")
  assert.equal(fact?.title, "发布分支")
  assert.deepEqual(fact?.tags, ["butler", "release"])
})

test("profile id is stable across sessions", () => {
  const projector = new ButlerSessionProjector()
  const first = projector.project(event(), context)
  const second = projector.project(
    event({
      id: "event-2",
      source: { kind: "butler_session", ref: "session-2" },
      payload: {
        userId: "user-1",
        sessionId: "session-2",
        summary: "更新了偏好。",
        profile: { communicationStyle: "直接给结论" },
      },
    }),
    context,
  )
  const firstProfile = first.find((record) => record.kind === "profile")
  const secondProfile = second.find((record) => record.kind === "profile")
  assert.equal(firstProfile?.id, secondProfile?.id)
  assert.notEqual(firstProfile?.checksum, secondProfile?.checksum)
})

test("rejects a user id outside the projection scope", () => {
  assert.throws(
    () =>
      new ButlerSessionProjector().project(
        event({
          payload: { userId: "user-2", sessionId: "s", summary: "x" },
        }),
        context,
      ),
    /does not match/,
  )
})

test("rejects a project-scope context", () => {
  assert.throws(
    () =>
      new ButlerSessionProjector().project(event(), {
        scope: { scope: "project", ownerId: "user-1", projectId: "p" },
        now: "2026-11-17T10:00:00Z",
      }),
    /user-scope/,
  )
})
