import * as z from 'zod';
import { LOG_LEVELS } from './loggingTypes';

export const ANALYSIS_LIMITS = {
    maxIterations: { default: 100, min: 3, max: 200 },
    requestTimeoutSeconds: { default: 300, min: 60, max: 600 },
} as const;

export const SUBAGENT_LIMITS = {
    maxPerSession: { default: 30, min: 1, max: 100 },
} as const;

export const RECURSION_LIMITS = {
    maxDepth: { default: 2, min: 0, max: 3 },
} as const;

/**
 * Analysis approach strategies:
 * - "rlm": Recursive Language Model approach. Diff is NOT embedded in the prompt.
 *   The LLM uses list_changed_files and get_file_diff tools to access diff on demand.
 *   More efficient for large diffs and enables recursive decomposition.
 * - "legacy": Traditional approach. Full diff is embedded in the user prompt.
 *   Simpler but wastes context window on large diffs.
 */
export const ANALYSIS_APPROACHES = ['rlm', 'legacy'] as const;
export type AnalysisApproach = (typeof ANALYSIS_APPROACHES)[number];

export const WorkspaceSettingsSchema = z.looseObject({
    selectedRepositoryPath: z.string().optional(),
    /** Model identifier in format 'vendor/id' (e.g., 'copilot/gpt-4.1') */
    preferredModelIdentifier: z.string().optional(),
    maxIterations: z
        .number()
        .min(ANALYSIS_LIMITS.maxIterations.min)
        .max(ANALYSIS_LIMITS.maxIterations.max)
        .default(ANALYSIS_LIMITS.maxIterations.default),
    requestTimeoutSeconds: z
        .number()
        .min(ANALYSIS_LIMITS.requestTimeoutSeconds.min)
        .max(ANALYSIS_LIMITS.requestTimeoutSeconds.max)
        .default(ANALYSIS_LIMITS.requestTimeoutSeconds.default),
    maxSubagentsPerSession: z
        .number()
        .min(SUBAGENT_LIMITS.maxPerSession.min)
        .max(SUBAGENT_LIMITS.maxPerSession.max)
        .default(SUBAGENT_LIMITS.maxPerSession.default),
    /** Maximum recursion depth for recursive review mode (0 = flat/linear) */
    maxRecursionDepth: z
        .number()
        .min(RECURSION_LIMITS.maxDepth.min)
        .max(RECURSION_LIMITS.maxDepth.max)
        .default(RECURSION_LIMITS.maxDepth.default),
    /** Analysis approach: "rlm" (diff-on-demand) or "legacy" (full diff in prompt) */
    analysisApproach: z.enum(ANALYSIS_APPROACHES).default('rlm'),
    logLevel: z.enum(LOG_LEVELS).default('info'),
});

export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
