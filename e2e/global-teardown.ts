import { existsSync, readFileSync } from 'node:fs'
import { loadE2EEnv } from './support/env'
import { teardown } from './support/seed'

export default async function globalTeardown() {
  if (!existsSync('e2e/.auth/fixtures.json')) return
  await teardown(loadE2EEnv(), JSON.parse(readFileSync('e2e/.auth/fixtures.json', 'utf8')))
}
