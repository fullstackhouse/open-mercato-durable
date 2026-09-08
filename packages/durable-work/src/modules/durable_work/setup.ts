import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['durable_work.view', 'durable_work.operate'],
    admin: ['durable_work.view', 'durable_work.operate'],
  },
}

export default setup
