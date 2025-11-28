export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = typeof LOG_LEVELS[number];

export const OUTPUT_TARGETS = ['channel', 'console'] as const;
export type OutputTarget = typeof OUTPUT_TARGETS[number];
