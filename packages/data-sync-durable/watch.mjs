import { watch } from '../../scripts/watch.mjs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

watch(dirname(fileURLToPath(import.meta.url)))
