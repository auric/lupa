import { z } from 'zod/v4';
import { EmbeddingModel } from '../services/embeddingModelSelectionService';
import { LOG_LEVELS, OUTPUT_TARGETS } from './loggingTypes';

export const ANALYSIS_LIMITS = {
    maxIterations: { default: 100, min: 3, max: 200 },
    requestTimeoutSeconds: { default: 60, min: 10, max: 300 },
} as const;

export const SUBAGENT_LIMITS = {
    maxPerSession: { default: 10, min: 1, max: 50 },
    timeoutSeconds: { default: 300, min: 30, max: 600 },
} as const;

export const WorkspaceSettingsSchema = z.looseObject({
    selectedEmbeddingModel: z.enum(EmbeddingModel).optional(),
    lastIndexingTimestamp: z.number().positive().optional(),
    preferredModelFamily: z.string().optional(),
    preferredModelVersion: z.string().optional(),
    enableEmbeddingLspAlgorithm: z.boolean().default(false),
    maxIterations: z.number()
        .min(ANALYSIS_LIMITS.maxIterations.min)
        .max(ANALYSIS_LIMITS.maxIterations.max)
        .default(ANALYSIS_LIMITS.maxIterations.default),
    requestTimeoutSeconds: z.number()
        .min(ANALYSIS_LIMITS.requestTimeoutSeconds.min)
        .max(ANALYSIS_LIMITS.requestTimeoutSeconds.max)
        .default(ANALYSIS_LIMITS.requestTimeoutSeconds.default),
    maxSubagentsPerSession: z.number()
        .min(SUBAGENT_LIMITS.maxPerSession.min)
        .max(SUBAGENT_LIMITS.maxPerSession.max)
        .default(SUBAGENT_LIMITS.maxPerSession.default),
    subagentTimeoutSeconds: z.number()
        .min(SUBAGENT_LIMITS.timeoutSeconds.min)
        .max(SUBAGENT_LIMITS.timeoutSeconds.max)
        .default(SUBAGENT_LIMITS.timeoutSeconds.default),
    logLevel: z.enum(LOG_LEVELS).default('info'),
    logOutputTarget: z.enum(OUTPUT_TARGETS).default('console'),
});

export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
