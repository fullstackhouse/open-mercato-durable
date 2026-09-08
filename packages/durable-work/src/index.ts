// Public API of @fullstackhouse/open-mercato-durable-work.
// The OM module itself lives at ./modules/durable_work and is loaded by the host
// through `{ id: 'durable_work', from: '@fullstackhouse/open-mercato-durable-work' }`.
export { metadata } from './modules/durable_work/index'
export { features } from './modules/durable_work/acl'
