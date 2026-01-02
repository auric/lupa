import * as z from 'zod';
import { LOG_LEVELS } from './loggingTypes';

export const ANALYSIS_LIMITS = {
    maxIterations: { default: 100, min: 3, max: 200 },
    requestTimeoutSeconds: { default: 300, min: 60, max: 600 },
} as const;

export const SUBAGENT_LIMITS = {
    maxPerSession: { default: 10, min: 1, max: 50 },
} as const;

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
    logLevel: z.enum(LOG_LEVELS).default('info'),
});

export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
