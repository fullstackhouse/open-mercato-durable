import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'example_sync',
  title: 'Example Sync',
  version: '0.0.1',
  description:
    'A data_sync integration whose behaviour a test writes out: batch count, per-batch delay, and injected failures. It exists so the durable adopter can be exercised end to end without a real external system, and so failures a real adapter only produces by accident can be produced on purpose.',
}

export default metadata
