// Sanity-checks supabase/migrations. Catches the mistakes that have actually
// cost time here: a malformed name the CLI silently ignores and two files sharing
// one version (the second never applies). A gap in the
// numbering is only a warning — 000017 is intentionally absent.
import { readdirSync } from 'node:fs'

const dir = new URL('../supabase/migrations/', import.meta.url)
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
const errors = []
const seen = new Map()

for (const f of files) {
  const m = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(f)
  if (!m) { errors.push(`bad name (want <14-digit version>_<snake_case>.sql): ${f}`); continue }
  if (seen.has(m[1])) errors.push(`duplicate version ${m[1]}: ${seen.get(m[1])} and ${f}`)
  seen.set(m[1], f)
  const seq = Number(m[1].slice(-6)), last = Number([...seen.keys()].at(-2)?.slice(-6) ?? seq - 1)
  if (seen.size > 1 && seq !== last + 1) console.warn(`note: numbering gap before ${f}`)
}

if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
console.log(`${files.length} migrations OK`)
