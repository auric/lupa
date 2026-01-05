import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import {
    WorkspaceSettingsSchema,
    ANALYSIS_LIMITS,
    SUBAGENT_LIMITS,
} from '../models/workspaceSettingsSchema';

describe('WorkspaceSettingsSchema', () => {
    describe('valid settings', () => {
        it('should accept empty object and apply defaults', () => {
            const result = WorkspaceSettingsSchema.safeParse({});
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.maxIterations).toBe(
                    ANALYSIS_LIMITS.maxIterations.default
                );
                expect(result.data.requestTimeoutSeconds).toBe(
                    ANALYSIS_LIMITS.requestTimeoutSeconds.default
                );
                expect(result.data.maxSubagentsPerSession).toBe(
                    SUBAGENT_LIMITS.maxPerSession.default
                );
                expect(result.data.logLevel).toBe('info');
            }
        });

        it('should accept all valid properties and preserve them', () => {
            const validSettings = {
                preferredModelIdentifier: 'copilot/gpt-4.1',
                maxIterations: 20,
                requestTimeoutSeconds: 120,
                maxSubagentsPerSession: 15,
                logLevel: 'debug' as const,
                lspOperationTimeoutSeconds: 30,
                symbolSearchTimeoutSeconds: 15,
            };

            const result = WorkspaceSettingsSchema.safeParse(validSettings);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data).toEqual(validSettings);
            }
        });

        it('should accept boundary values for numeric limits', () => {
            const lowerBoundarySettings = {
                maxIterations: ANALYSIS_LIMITS.maxIterations.min,
                requestTimeoutSeconds:
                    ANALYSIS_LIMITS.requestTimeoutSeconds.min,
                maxSubagentsPerSession: SUBAGENT_LIMITS.maxPerSession.min,
            };

            const result = WorkspaceSettingsSchema.safeParse(
                lowerBoundarySettings
            );
            expect(result.success).toBe(true);

            const upperBoundarySettings = {
                maxIterations: ANALYSIS_LIMITS.maxIterations.max,
                requestTimeoutSeconds:
                    ANALYSIS_LIMITS.requestTimeoutSeconds.max,
                maxSubagentsPerSession: SUBAGENT_LIMITS.maxPerSession.max,
            };

            const upperResult = WorkspaceSettingsSchema.safeParse(
                upperBoundarySettings
            );
            expect(upperResult.success).toBe(true);
        });

        it('should preserve unknown properties via loose schema', () => {
            const settingsWithExtra = {
                maxIterations: 50,
                customProperty: 'custom-value',
                nestedObject: { foo: 'bar' },
            };

            const result = WorkspaceSettingsSchema.safeParse(settingsWithExtra);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.customProperty).toBe('custom-value');
                expect(result.data.nestedObject).toEqual({ foo: 'bar' });
            }
        });

        it('should accept valid log settings', () => {
            const result = WorkspaceSettingsSchema.safeParse({
                logLevel: 'debug',
            });
            expect(result.success).toBe(true);
        });
    });

    describe('invalid settings', () => {
        it('should reject maxIterations below minimum', () => {
            const result = WorkspaceSettingsSchema.safeParse({
                maxIterations: 1,
            });
            expect(result.success).toBe(false);
        });

        it('should reject maxIterations above maximum', () => {
            const result = WorkspaceSettingsSchema.safeParse({
                maxIterations: ANALYSIS_LIMITS.maxIterations.max + 1,
            });
            expect(result.success).toBe(false);
        });

        it('should reject requestTimeoutSeconds below minimum', () => {
            const result = WorkspaceSettingsSchema.safeParse({
                requestTimeoutSeconds: 5,
            });
            expect(result.success).toBe(false);
        });

        it('should reject requestTimeoutSeconds above maximum', () => {
            const result = WorkspaceSettingsSchema.safeParse({
                requestTimeoutSeconds: 700,
            });
            expect(result.success).toBe(false);
        });

        it('should reject maxSubagentsPerSession below minimum', () => {
            const result = WorkspaceSettingsSchema.safeParse({
                maxSubagentsPerSession: 0,
            });
            expect(result.success).toBe(false);
        });

        it('should reject maxSubagentsPerSession above maximum', () => {
            const result = WorkspaceSettingsSchema.safeParse({
                maxSubagentsPerSession: SUBAGENT_LIMITS.maxPerSession.max + 1,
            });
            expect(result.success).toBe(false);
        });

        it('should reject wrong types', () => {
            const result = WorkspaceSettingsSchema.safeParse({
                maxIterations: 'fifty',
            });
            expect(result.success).toBe(false);
        });

        it('should reject invalid logLevel', () => {
            const result = WorkspaceSettingsSchema.safeParse({
                logLevel: 'verbose',
            });
            expect(result.success).toBe(false);
        });
    });

    describe('error formatting', () => {
        it('should provide readable error messages', () => {
            const result = WorkspaceSettingsSchema.safeParse({
                maxIterations: ANALYSIS_LIMITS.maxIterations.min - 1,
                maxSubagentsPerSession: SUBAGENT_LIMITS.maxPerSession.max + 1,
            });

            expect(result.success).toBe(false);
            if (!result.success) {
                const formatted = z.prettifyError(result.error);
                expect(formatted).toContain('maxIterations');
                expect(formatted).toContain('maxSubagentsPerSession');
            }
        });
    });
});
