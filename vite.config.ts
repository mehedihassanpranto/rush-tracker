import http from 'node:http'
import type { Socket } from 'node:net'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const PATCHED = Symbol.for('rush-tracker.no-stale-worker-sockets')

/**
 * Dev only: stops the random "socket hang up" / "read ECONNRESET" error
 * overlay.
 *
 * Vite forwards every request to the Nitro dev worker over a local HTTP
 * connection (env-runner → httpxy), and httpxy pools those connections
 * (keep-alive). The worker's Node HTTP server closes a connection that has
 * been idle ~5–6 s. A request sent at that instant goes out on a socket the
 * worker has just closed and dies — nothing retries it. Reproduced on demand
 * (2026-10-12): 7 of 360 requests failed when fired ~6 s after the previous
 * ones; 0 with this plugin.
 *
 * Fix: never keep a loopback (or unix-socket) connection in an agent's pool in
 * the dev server process, so every request to the worker opens a fresh one.
 * A local connect costs well under a millisecond. Nothing here is part of the
 * production build (`apply: 'serve'`), which has no worker proxy at all.
 */
function noStaleWorkerSockets(): Plugin {
  return {
    name: 'rush-tracker:no-stale-worker-sockets',
    apply: 'serve',
    configureServer() {
      const proto = http.Agent.prototype as http.Agent & { [PATCHED]?: true }
      if (proto[PATCHED]) return
      proto[PATCHED] = true
      const keepSocketAlive = proto.keepSocketAlive
      proto.keepSocketAlive = function (socket) {
        const address = (socket as Socket).remoteAddress
        const local =
          address === undefined || // unix socket / named pipe
          address === '127.0.0.1' ||
          address === '::1' ||
          address === '::ffff:127.0.0.1'
        return local ? false : keepSocketAlive.call(this, socket)
      }
    },
  }
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // Dev only: the startup scan misses these (TanStack Start imports them from
  // generated code), so a cold server found them on the first page load,
  // re-bundled React mid-render and broke that page ("reading 'useEffect'" /
  // 504 Outdated Optimize Dep) — the first e2e test on a fresh CI cache.
  optimizeDeps: {
    include: ['@tanstack/router-core', '@tanstack/router-core/isServer', '@tanstack/router-core/ssr/client', 'seroval'],
  },
  plugins: [
    noStaleWorkerSockets(),
    devtools(),
    nitro({ rollupConfig: { external: [/^@sentry\//] } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
