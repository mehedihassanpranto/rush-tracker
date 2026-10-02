import { createStart } from '@tanstack/react-start'
import { errorCaptureMiddleware } from '@/server/monitoring/error-capture'

/**
 * TanStack Start instance (picked up automatically as the `start` entry).
 * functionMiddleware runs around EVERY server function.
 */
export const startInstance = createStart(() => ({
  functionMiddleware: [errorCaptureMiddleware],
}))
