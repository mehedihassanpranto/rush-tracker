import { mkdirSync, writeFileSync } from 'node:fs'
import { loadE2EEnv } from './support/env'
import { seed, sessionCookies, type Role } from './support/seed'

export default async function globalSetup() {
  const env = loadE2EEnv()
  const run = `${Date.now().toString(36)}`
  const f = await seed(env, run)
  mkdirSync('e2e/.auth', { recursive: true })
  writeFileSync('e2e/.auth/fixtures.json', JSON.stringify(f, null, 2))
  for (const role of Object.keys(f.users) as Role[]) {
    const cookies = await sessionCookies(env, f.users[role].email)
    writeFileSync(`e2e/.auth/${role}.json`, JSON.stringify({ cookies, origins: [] }))
  }
}
