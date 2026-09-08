// The worker process, and the operator's command line.
//
// `mercato durable_work worker` is how the mechanism runs in production. It is deliberately
// its own process: a slice can run for minutes, and hosting that inside the web process means
// a deploy either kills work mid-batch or holds the deploy open for the length of a slice.

import type { AppContainer } from '@open-mercato/shared/lib/di/container'

import { DurableWorkService } from '../../core/service'
import { registry } from '../../core/registry'
import { startWorker } from '../../core/worker'
import { readConfig } from '../../om/config'
import type { SqlTransactor } from '../../core/types'
import type { TransportAdapter } from '../../transport/types'

type CommandContext = { container: AppContainer; args: string[] }

const flag = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

export const commands = [
  {
    id: 'durable_work worker',
    description: 'Run the durable work worker: binds every registered kind and owns the reconciler tick.',
    async run({ container, args }: CommandContext) {
      const config = readConfig()
      const sql = container.resolve('durableWorkSql') as SqlTransactor
      const transport = container.resolve('durableWorkTransport') as TransportAdapter

      const worker = await startWorker({
        sql,
        transport,
        registry,
        kinds: flag(args, 'kinds')?.split(','),
        concurrency: flag(args, 'concurrency') ? Number(flag(args, 'concurrency')) : undefined,
        tickMs: config.tickMs,
        reconcilerGraceMs: config.reconcilerGraceMs,
        drainTimeoutMs: config.drainTimeoutMs,
        log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
      })

      console.log(
        JSON.stringify({
          event: 'durable_work.worker_started',
          owner: worker.owner,
          transport: transport.name,
          kinds: registry.list().map((k) => k.kind),
        }),
      )

      // SIGTERM is what a deploy sends. Draining rather than exiting is the difference between
      // a slice handing its remaining work back and a slice being killed between two writes.
      let stopping = false
      const stop = async (signal: string) => {
        if (stopping) return
        stopping = true
        console.log(JSON.stringify({ event: 'durable_work.worker_draining', signal, timeoutMs: config.drainTimeoutMs }))
        await worker.stop()
        console.log(JSON.stringify({ event: 'durable_work.worker_stopped' }))
        process.exit(0)
      }
      process.on('SIGTERM', () => void stop('SIGTERM'))
      process.on('SIGINT', () => void stop('SIGINT'))

      await new Promise(() => undefined) // run until signalled
    },
  },
  {
    id: 'durable_work reconcile',
    description: 'Run one reconciler pass and print what it repaired.',
    async run({ container }: CommandContext) {
      const service = container.resolve('durableWorkService') as DurableWorkService
      console.log(JSON.stringify(await service.reconcile(), null, 2))
    },
  },
]

export default commands
