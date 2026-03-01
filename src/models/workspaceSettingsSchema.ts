import * as z from 'zod';
import { LOG_LEVELS } from './loggingTypes';

/**
 * Hardcoded analysis limits — not user-configurable.
 * These are set to generous values that work well for all cases.
 */
export const ANALYSIS_LIMITS = {
    maxIterations: 600,
    requestTimeoutSeconds: 300,
    maxSubagentsPerSession: 75,
    /**
     * Multiplier for computing per-session tool call limit from maxIterations.
     * Each iteration may produce 1-3 tool calls; multiplier of 3 gives headroom
     * without letting a pathological LLM run indefinitely.
     */
    toolCallMultiplier: 3,
} as const;

export const RECURSION_LIMITS = {
    maxDepth: { default: 2, min: 0, max: 3 },
} as const;

export const WorkspaceSettingsSchema = z.looseObject({
    selectedRepositoryPath: z.string().optional(),
    /** Model identifier in format 'vendor/id' (e.g., 'copilot/gpt-4.1') */
    preferredModelIdentifier: z.string().optional(),
    /** Maximum recursion depth for recursive review mode (0 = flat/linear) */
    maxRecursionDepth: z
        .number()
        .min(RECURSION_LIMITS.maxDepth.min)
        .max(RECURSION_LIMITS.maxDepth.max)
        .default(RECURSION_LIMITS.maxDepth.default),
    logLevel: z.enum(LOG_LEVELS).default('info'),
});

export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
