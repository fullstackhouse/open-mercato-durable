import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import type { CredentialsService } from '@open-mercato/core/modules/integrations/lib/credentials-service'

export const setup: ModuleSetupConfig = {
  // An empty credentials blob, because core refuses to run an integration that has none — and
  // this one deliberately has nothing to authenticate against. Without the row the engine
  // throws before it ever reaches the adapter, which looks like a durable-work failure and is
  // not one.
  async seedDefaults({ tenantId, organizationId, container }) {
    const credentials = container.resolve('integrationCredentialsService') as CredentialsService
    await credentials.save('example_sync', {}, { tenantId, organizationId })
  },
}

export default setup
