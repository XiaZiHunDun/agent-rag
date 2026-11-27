import {
  projectAndStore,
  retireSupersededRecords,
  type MemoryHit,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryScopeRef,
  type MemoryStoreStats,
  type ProjectionCheckpointStore,
  type ProjectionContext,
  type ProjectionEvent,
  type ProjectionRunReport,
  type Projector,
  type TextMemoryStore,
} from "@agent-rag/core"
import {
  collectInjection,
  type MemoryInjectionRequest,
  type MemoryInjectionResult,
} from "./injection.ts"

export interface AgentRagClientOptions {
  readonly store: TextMemoryStore
  readonly checkpointStore?: ProjectionCheckpointStore
  readonly projectors?: readonly Projector[]
}

/**
 * Thin facade used by WFXM runtimes.
 *
 * The butler runtime and task runtime each register their own projectors and
 * pass events with an explicit scope; the client never guesses a scope.
 */
export class AgentRagClient {
  private readonly store: TextMemoryStore
  private readonly checkpointStore?: ProjectionCheckpointStore
  private readonly projectors = new Map<string, Projector>()

  constructor(options: AgentRagClientOptions) {
    this.store = options.store
    this.checkpointStore = options.checkpointStore
    for (const projector of options.projectors ?? []) this.register(projector)
  }

  register(projector: Projector): void {
    this.projectors.set(projector.name, projector)
  }

  async project(
    projectorName: string,
    events: readonly ProjectionEvent[],
    context: ProjectionContext,
  ): Promise<ProjectionRunReport> {
    const projector = this.projectors.get(projectorName)
    if (!projector) throw new Error(`unknown projector: ${projectorName}`)
    return projectAndStore(
      projector,
      events,
      context,
      {
        upsertMany: async (records) => {
          await this.store.upsertMany(records)
          for (const record of records) {
            await retireSupersededRecords(this.store, record)
          }
        },
      },
      {
        ...(this.checkpointStore === undefined
          ? {}
          : { checkpointStore: this.checkpointStore }),
      },
    )
  }

  async recall(query: MemoryQuery): Promise<readonly MemoryHit[]> {
    return this.store.search(query)
  }

  /** Recall user + project memory and render an injectable system-prompt block. */
  async inject(request: MemoryInjectionRequest): Promise<MemoryInjectionResult> {
    return collectInjection(this.store, request)
  }

  /** Writes the record, then closes the validity window of superseded ones. */
  async remember(record: MemoryRecord): Promise<readonly string[]> {
    await this.store.upsert(record)
    return retireSupersededRecords(this.store, record)
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.store.get(id)
  }

  async forget(scope: MemoryScopeRef): Promise<number> {
    return this.store.deleteScope(scope)
  }

  async stats(): Promise<MemoryStoreStats> {
    return this.store.stats()
  }
}
