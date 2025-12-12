/**
 * Wraps a promise with a timeout.
 * @param promise The promise to wrap
 * @param timeoutMs Timeout in milliseconds
 * @param operation Description of the operation for error messages
 * @returns The promise result or throws on timeout
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}
