/**
 * Error thrown when an operation exceeds its time limit.
 * Use this instead of generic Error for timeout scenarios to enable
 * consistent error handling and instanceof checks.
 */
export class TimeoutError extends Error {
    override readonly name = 'TimeoutError';

    constructor(
        message: string,
        public readonly operation: string,
        public readonly timeoutMs: number
    ) {
        super(message);
        // Maintains proper stack trace for where error was thrown (only in V8)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, TimeoutError);
        }
    }

    /**
     * Create a TimeoutError with a standard message format
     */
    static create(operation: string, timeoutMs: number): TimeoutError {
        return new TimeoutError(
            `${operation} timed out after ${timeoutMs}ms`,
            operation,
            timeoutMs
        );
    }
}
