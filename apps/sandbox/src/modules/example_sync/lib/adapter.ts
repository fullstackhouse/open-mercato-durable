// A data_sync adapter whose behaviour a test dictates.
//
// Every real integration needs credentials and a system on the other end, which makes the
// interesting cases — a batch that fails, a stream that is slow enough to be interrupted, a run
// long enough to span slices — either impossible to arrange or dependent on someone else's
// outage. This one takes its behaviour from the run's own parameters, so a test asks for the
// failure it wants and gets exactly that.

import type {
  DataMapping,
  DataSyncAdapter,
  ImportBatch,
  ImportItem,
  StreamImportInput,
} from '@open-mercato/core/modules/data_sync/lib/adapter'

export const EXAMPLE_SYNC_PROVIDER = 'example_sync'
export const EXAMPLE_SYNC_INTEGRATION = 'example_sync'
export const EXAMPLE_ENTITY = 'example.record'

/** Thrown to make a batch fail on demand. Plain, so the durable layer classifies it transient. */
class ScriptedBatchFailure extends Error {
  constructor(batchIndex: number) {
    super(`Scripted failure at batch ${batchIndex}`)
    this.name = 'ScriptedBatchFailure'
  }
}

const number = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** How many batches this run has already committed, read from the cursor. The cursor IS the
 *  resume position, so honouring it is what makes the adapter replay-safe. */
const batchesDone = (cursor: string | undefined): number => (cursor ? number(JSON.parse(cursor).done, 0) : 0)

export const exampleSyncAdapter: DataSyncAdapter = {
  providerKey: EXAMPLE_SYNC_PROVIDER,
  direction: 'import',
  supportedEntities: [EXAMPLE_ENTITY],
  runMode: 'generic',
  operationalTelemetry: false,

  runParameters: [
    { key: 'batches', label: 'Batches', type: 'number', defaultValue: 5, description: 'How many batches this run produces in total.' },
    { key: 'itemsPerBatch', label: 'Items per batch', type: 'number', defaultValue: 2 },
    { key: 'batchDelayMs', label: 'Delay per batch (ms)', type: 'number', defaultValue: 0, description: 'Slows the stream so a run can be interrupted mid-flight.' },
    { key: 'failAtBatch', label: 'Fail at batch', type: 'number', defaultValue: -1, description: 'Throw on this batch index. -1 never fails.' },
    { key: 'failTimes', label: 'Fail this many times', type: 'number', defaultValue: 1, description: 'How often the injected failure recurs before the batch succeeds.' },
  ],

  // The cursor here is one run's scan position, not a durable position in a log, so it is not
  // mirrored into the shared cursor row — two runs of this entity must not redefine each
  // other's start.
  persistsSharedCursor: () => false,

  async getMapping(): Promise<DataMapping> {
    return { entityType: EXAMPLE_ENTITY, fields: [] }
  },

  async getInitialCursor() {
    return null
  },

  async validateConnection() {
    return { ok: true }
  },

  async *streamImport(input: StreamImportInput): AsyncIterable<ImportBatch> {
    const parameters = input.parameters ?? {}
    const batches = number(parameters.batches, 5)
    const itemsPerBatch = number(parameters.itemsPerBatch, 2)
    const batchDelayMs = number(parameters.batchDelayMs, 0)
    const failAtBatch = number(parameters.failAtBatch, -1)
    const failTimes = number(parameters.failTimes, 1)

    let done = batchesDone(input.cursor)
    // Counted per process, so an injected failure that is meant to recur a fixed number of
    // times stops recurring — which is how a test asserts that a transient failure is absorbed
    // rather than fatal.
    const failures = failureCounts.get(input.runId ?? 'anonymous') ?? 0

    while (done < batches) {
      if (batchDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, batchDelayMs))

      if (done === failAtBatch && failures < failTimes) {
        failureCounts.set(input.runId ?? 'anonymous', failures + 1)
        throw new ScriptedBatchFailure(done)
      }

      const items: ImportItem[] = Array.from({ length: itemsPerBatch }, (_unused, index) => ({
        externalId: `example-${done}-${index}`,
        data: { batch: done, index },
        action: 'create' as const,
      }))

      done += 1
      yield {
        items,
        cursor: JSON.stringify({ done }),
        hasMore: done < batches,
        totalEstimate: batches * itemsPerBatch,
        processedCount: items.length,
        batchIndex: done - 1,
        message: `Example batch ${done} of ${batches}`,
      }
    }
  },
}

/** Per-process, and deliberately not persisted: a restarted worker starts the injected failure
 *  budget again, which is what makes "this failure recurs N times" mean N times *in a row*. */
const failureCounts = new Map<string, number>()

export function resetScriptedFailures(): void {
  failureCounts.clear()
}
