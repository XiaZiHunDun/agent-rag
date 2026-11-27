import type { AgentRagClient } from "@agent-rag/client"
import { createWfxmButlerMemory, type WfxmButlerMemory } from "./wfxm-butler-memory.ts"
import { createWfxmTaskMemory, type WfxmTaskMemory } from "./wfxm-task-memory.ts"

export interface WfxmMemoryPortsOptions {
  readonly client: AgentRagClient
  /** WFXM is single-owner; both ports project into this owner's scope. */
  readonly ownerId: string
  readonly clock?: () => string
  readonly recallLimit?: number
}

export interface WfxmMemoryPorts {
  readonly butler: WfxmButlerMemory
  readonly task: WfxmTaskMemory
}

/**
 * One-call wiring for WFXM's assembly layer:
 *
 *   const memory = createWfxmMemoryPorts({ client, ownerId })
 *   createButlerAssembly({ ..., butlerMemory: memory.butler, taskMemory: memory.task })
 */
export function createWfxmMemoryPorts(options: WfxmMemoryPortsOptions): WfxmMemoryPorts {
  return {
    butler: createWfxmButlerMemory({
      client: options.client,
      ownerId: options.ownerId,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.recallLimit === undefined ? {} : { recallLimit: options.recallLimit }),
    }),
    task: createWfxmTaskMemory({
      client: options.client,
      ownerId: options.ownerId,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    }),
  }
}
