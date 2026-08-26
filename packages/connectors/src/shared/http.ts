/**
 * Turns a network-level `fetch` rejection into something actionable.
 *
 * `fetch` rejects with a bare "fetch failed" TypeError for DNS errors,
 * connection resets, TLS problems and proxy misconfiguration alike — naming
 * neither the target nor the cause. Timeouts arrive as a separate abort-shaped
 * error and deserve a distinct message, since the fix differs.
 */
export function describeNetworkFailure(
  error: unknown,
  url: string,
  timeoutMs: number,
  subject = 'the server',
): Error {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new Error(`Request to ${subject} timed out after ${timeoutMs}ms: ${url}`)
  }

  const reason = error instanceof Error ? error.message : String(error)
  return new Error(
    `Could not reach ${subject} (${reason}): ${url}. Check network connectivity or proxy settings.`,
  )
}
