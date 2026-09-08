// The worker process, and the operator's command line.
//
// `mercato durable_work worker` is how the mechanism runs in production. It is deliberately its
// own process: a slice can run for minutes, and hosting that inside the web process means a
// deploy either kills work mid-batch or holds the deploy open for the length of a slice.

import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

import type { DurableWorkService } from '../../core/service'
import { registry } from '../../core/registry'
import { startWorker } from '../../core/worker'
import { readConfig } from '../../om/config'
import type { SqlTransactor } from '../../core/types'
import type { TransportAdapter } from '../../transport/types'

const flag = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

const emit = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...fields }))

const workerCommand: ModuleCli = {
  command: 'worker',
  async run(argv: string[]) {
    const config = readConfig()
    const container = await createRequestContainer()
    const sql = container.resolve('durableWorkSql') as SqlTransactor
    const transport = container.resolve('durableWorkTransport') as TransportAdapter

    const worker = await startWorker({
      sql,
      transport,
      registry,
      kinds: flag(argv, 'kinds')?.split(','),
      concurrency: flag(argv, 'concurrency') ? Number(flag(argv, 'concurrency')) : undefined,
      tickMs: config.tickMs,
      reconcilerGraceMs: config.reconcilerGraceMs,
      drainTimeoutMs: config.drainTimeoutMs,
      log: (event, fields) => emit(event, fields),
    })

    emit('durable_work.worker_started', {
      owner: worker.owner,
      transport: transport.name,
      kinds: registry.list().map((kind) => kind.kind),
    })

    // SIGTERM is what a deploy sends. Draining rather than exiting is the difference between a
    // slice handing its remaining work back and a slice being killed between two writes.
    let stopping = false
    const stop = async (signal: string) => {
      if (stopping) return
      stopping = true
      emit('durable_work.worker_draining', { signal, timeoutMs: config.drainTimeoutMs })
      await worker.stop()
      emit('durable_work.worker_stopped')
      process.exit(0)
    }
    process.on('SIGTERM', () => void stop('SIGTERM'))
    process.on('SIGINT', () => void stop('SIGINT'))

    await new Promise(() => undefined) // run until signalled
  },
}

const reconcileCommand: ModuleCli = {
  command: 'reconcile',
  async run() {
    const container = await createRequestContainer()
    const service = container.resolve('durableWorkService') as DurableWorkService
    console.log(JSON.stringify(await service.reconcile(), null, 2))
  },
}

const helpCommand: ModuleCli = {
  command: 'help',
  async run() {
    console.log(
      [
        'mercato durable_work worker [--kinds a,b] [--concurrency n]',
        '    Bind every registered kind, own the reconciler tick, drain on SIGTERM.',
        'mercato durable_work reconcile',
        '    Run one reconciler pass and print what it repaired.',
      ].join('\n'),
    )
  },
}

export default [workerCommand, reconcileCommand, helpCommand]
