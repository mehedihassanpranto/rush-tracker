import { readFileSync } from 'node:fs'
import type { Fixtures } from './seed'

export function fixtures(): Fixtures {
  return JSON.parse(readFileSync('e2e/.auth/fixtures.json', 'utf8'))
}
export const auth = (role: string) => ({ storageState: `e2e/.auth/${role}.json` })
