import type { MemoryRecord, MemorySource, MemorySourceKind } from "./memory-record.ts"
import type { MemoryScopeRef } from "./scope.ts"

/**
 * A projector consumes runtime events (butler turns, pi task results) and emits
 * durable memory records. Records must be derived, never raw transcripts.
 */
export interface ProjectionEvent {
  readonly id: string
  /** e.g. "butler.turn.completed" / "task.completed". */
  readonly type: string
  readonly occurredAt: string
  readonly source: MemorySource
  readonly payload: unknown
}

export interface ProjectionContext {
  readonly scope: MemoryScopeRef
  /** Evaluation clock; defaults to now when omitted by the runner. */
  readonly now: string
}

export interface Projector {
  readonly name: string
  readonly sourceKind: MemorySourceKind
  supports(event: ProjectionEvent): boolean
  project(
    event: ProjectionEvent,
    context: ProjectionContext,
  ): Promise<readonly MemoryRecord[]> | readonly MemoryRecord[]
}

export interface ProjectionReport {
  readonly projector: string
  readonly processed: number
  readonly projected: number
  readonly skipped: number
  readonly records: readonly MemoryRecord[]
  readonly issues: readonly string[]
}

/**
 * Run a projector over a batch.
 *
 * - unsupported events are counted as skipped;
 * - duplicate ids inside one batch are collapsed (idempotent projection);
 * - a projector failure is reported without aborting the whole batch.
 */
export async function runProjector(
  projector: Projector,
  events: readonly ProjectionEvent[],
  context: ProjectionContext,
): Promise<ProjectionReport> {
  const records = new Map<string, MemoryRecord>()
  const issues: string[] = []
  let skipped = 0

  for (const event of events) {
    if (!projector.supports(event)) {
      skipped += 1
      continue
    }
    try {
      const produced = await projector.project(event, context)
      for (const record of produced) {
        records.set(record.id, record)
      }
    } catch (error) {
      issues.push(
        `${projector.name} failed on ${event.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return {
    projector: projector.name,
    processed: events.length,
    projected: records.size,
    skipped,
    records: [...records.values()],
    issues,
  }
}

export interface ProjectionCheckpoint {
  readonly projector: string
  readonly lastEventId: string
  readonly updatedAt: string
}

export interface ProjectionCheckpointStore {
  get(projector: string): Promise<ProjectionCheckpoint | null>
  set(checkpoint: ProjectionCheckpoint): Promise<void>
}

export interface MemoryRecordSink {
  upsertMany(records: readonly MemoryRecord[]): Promise<void>
}

export interface ProjectionRunReport extends ProjectionReport {
  readonly written: number
  readonly checkpoint?: ProjectionCheckpoint
}

export interface ProjectAndStoreOptions {
  readonly checkpointStore?: ProjectionCheckpointStore
  /** Clock override for deterministic tests. */
  readonly now?: string
}

function eventsAfter(
  events: readonly ProjectionEvent[],
  lastEventId: string,
): readonly ProjectionEvent[] {
  const index = events.findIndex((event) => event.id === lastEventId)
  return index >= 0 ? events.slice(index + 1) : events
}

/**
 * Project -> dedupe -> write -> checkpoint.
 *
 * The checkpoint advances only after a successful write and only when the
 * projector reported no issues; otherwise the same window can be retried.
 */
export async function projectAndStore(
  projector: Projector,
  events: readonly ProjectionEvent[],
  context: ProjectionContext,
  sink: MemoryRecordSink,
  options: ProjectAndStoreOptions = {},
): Promise<ProjectionRunReport> {
  const checkpointStore = options.checkpointStore
  const previous = checkpointStore ? await checkpointStore.get(projector.name) : null
  const pending = previous ? eventsAfter(events, previous.lastEventId) : events
  const report = await runProjector(projector, pending, context)

  if (report.records.length > 0) {
    await sink.upsertMany(report.records)
  }

  const last = pending[pending.length - 1]
  const checkpoint: ProjectionCheckpoint | undefined =
    last && report.issues.length === 0
      ? {
          projector: projector.name,
          lastEventId: last.id,
          updatedAt: options.now ?? context.now,
        }
      : undefined

  if (checkpoint && checkpointStore) await checkpointStore.set(checkpoint)

  return {
    ...report,
    written: report.records.length,
    ...(checkpoint ? { checkpoint } : {}),
  }
}

/** Small in-memory checkpoint store for local runs and tests. */
export class InMemoryProjectionCheckpointStore implements ProjectionCheckpointStore {
  private readonly checkpoints = new Map<string, ProjectionCheckpoint>()

  async get(projector: string): Promise<ProjectionCheckpoint | null> {
    return this.checkpoints.get(projector) ?? null
  }

  async set(checkpoint: ProjectionCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.projector, checkpoint)
  }
}
