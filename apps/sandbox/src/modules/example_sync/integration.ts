import type { IntegrationBundle, IntegrationDefinition } from '@open-mercato/shared/modules/integrations/types'

// Collected by the generator, like every other data_sync provider's. `hub: 'data_sync'` is what
// makes it appear in `/api/data_sync/options`; without it the integration is registered but
// invisible to the module that would run it.
export const integration: IntegrationDefinition = {
  id: 'example_sync',
  title: 'Example Sync (scripted)',
  description:
    'A data_sync integration whose behaviour a test writes out: batch count, per-batch delay and injected failures. Needs no external system, so the interesting failures can be produced on purpose rather than waited for.',
  category: 'data_sync',
  hub: 'data_sync',
  providerKey: 'example_sync',
  icon: 'flask-conical',
  // Enabled by default and with no credentials: a fresh tenant — including the throwaway one
  // an ephemeral e2e run creates — can start a run immediately, with nothing to seed.
  defaultState: { isEnabled: true },
}

export const integrations: IntegrationDefinition[] = [integration]
export const bundles: IntegrationBundle[] = []
export const bundle: IntegrationBundle | undefined = undefined
