import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'durable_work',
  title: 'Durable Work',
  version: '0.0.1',
  description:
    'Durable at-least-once background work: a leased job record with epoch fencing, bounded resumable slices, a server-side reconciler, fenced cancel and an operator API. Other modules register job kinds; this module runs them.',
  author: 'Full Stack House',
  license: 'MIT',
  ejectable: true,
}

export { features } from './acl'

export default metadata
