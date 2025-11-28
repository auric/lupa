import { z } from 'zod/v4';
import { EmbeddingModel } from '../services/embeddingModelSelectionService';
import { LOG_LEVELS, OUTPUT_TARGETS } from './loggingTypes';

export const ANALYSIS_LIMITS = {
    maxToolCalls: { default: 50, min: 10, max: 200 },
    maxIterations: { default: 40, min: 3, max: 100 },
    requestTimeoutSeconds: { default: 60, min: 10, max: 300 },
} as const;

export const WorkspaceSettingsSchema = z.looseObject({
    selectedEmbeddingModel: z.enum(EmbeddingModel).optional(),
    lastIndexingTimestamp: z.number().positive().optional(),
    preferredModelFamily: z.string().optional(),
    preferredModelVersion: z.string().optional(),
    enableEmbeddingLspAlgorithm: z.boolean().default(false),
    maxToolCalls: z.number()
        .min(ANALYSIS_LIMITS.maxToolCalls.min)
        .max(ANALYSIS_LIMITS.maxToolCalls.max)
        .default(ANALYSIS_LIMITS.maxToolCalls.default),
    maxIterations: z.number()
        .min(ANALYSIS_LIMITS.maxIterations.min)
        .max(ANALYSIS_LIMITS.maxIterations.max)
        .default(ANALYSIS_LIMITS.maxIterations.default),
    requestTimeoutSeconds: z.number()
        .min(ANALYSIS_LIMITS.requestTimeoutSeconds.min)
        .max(ANALYSIS_LIMITS.requestTimeoutSeconds.max)
        .default(ANALYSIS_LIMITS.requestTimeoutSeconds.default),
    logLevel: z.enum(LOG_LEVELS).default('info'),
    logOutputTarget: z.enum(OUTPUT_TARGETS).default('console'),
});

export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
