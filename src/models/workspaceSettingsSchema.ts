import { z } from 'zod/v4';
import { EmbeddingModel } from '../services/embeddingModelSelectionService';
import { LOG_LEVELS } from './loggingTypes';

export const ANALYSIS_LIMITS = {
    maxIterations: { default: 100, min: 3, max: 200 },
    requestTimeoutSeconds: { default: 300, min: 60, max: 600 },
} as const;

export const SUBAGENT_LIMITS = {
    maxPerSession: { default: 10, min: 1, max: 50 },
} as const;

export const WorkspaceSettingsSchema = z.looseObject({
    selectedEmbeddingModel: z.enum(EmbeddingModel).optional(),
    selectedRepositoryPath: z.string().optional(),
    lastIndexingTimestamp: z.number().positive().optional(),
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
    logLevel: z.enum(LOG_LEVELS).default('info'),
});

export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
