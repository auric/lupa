import { describe, it, expect } from 'vitest';
import {
    WorkspaceSettingsSchema,
    ANALYSIS_LIMITS,
    RECURSION_LIMITS,
} from '../models/workspaceSettingsSchema';

describe('WorkspaceSettingsSchema', () => {
    describe('valid settings', () => {
        it('should accept empty object and apply defaults', () => {
            const result = WorkspaceSettingsSchema.safeParse({});
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.maxRecursionDepth).toBe(
                    RECURSION_LIMITS.maxDepth.default
                );
                expect(result.data.logLevel).toBe('info');
            }
        });

        it('should accept all valid properties and preserve them', () => {
            const validSettings = {
                preferredModelIdentifier: 'copilot/gpt-4.1',
                maxRecursionDepth: 1,
                logLevel: 'debug' as const,
            };

            const result = WorkspaceSettingsSchema.safeParse(validSettings);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data).toEqual({
                    ...validSettings,
                });
            }
        });

        it('should preserve unknown properties via loose schema', () => {
            const settingsWithExtra = {
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
        it('should reject invalid logLevel', () => {
            const result = WorkspaceSettingsSchema.safeParse({
                logLevel: 'verbose',
            });
            expect(result.success).toBe(false);
        });
    });

    describe('recursion settings', () => {
        it('should accept valid maxRecursionDepth values', () => {
            for (const depth of [
                RECURSION_LIMITS.maxDepth.min,
                RECURSION_LIMITS.maxDepth.default,
                RECURSION_LIMITS.maxDepth.max,
            ]) {
                const result = WorkspaceSettingsSchema.safeParse({
                    maxRecursionDepth: depth,
                });
                expect(result.success).toBe(true);
                if (result.success) {
                    expect(result.data.maxRecursionDepth).toBe(depth);
                }
            }
        });

        it('should reject maxRecursionDepth outside bounds', () => {
            expect(
                WorkspaceSettingsSchema.safeParse({
                    maxRecursionDepth: RECURSION_LIMITS.maxDepth.min - 1,
                }).success
            ).toBe(false);
            expect(
                WorkspaceSettingsSchema.safeParse({
                    maxRecursionDepth: RECURSION_LIMITS.maxDepth.max + 1,
                }).success
            ).toBe(false);
        });
    });

    describe('hardcoded analysis limits', () => {
        it('should have reasonable constant values', () => {
            expect(ANALYSIS_LIMITS.maxIterations).toBe(600);
            expect(ANALYSIS_LIMITS.requestTimeoutSeconds).toBe(120);
            expect(ANALYSIS_LIMITS.maxSubagentsPerSession).toBe(75);
            expect(ANALYSIS_LIMITS.toolCallMultiplier).toBe(3);
        });
    });
});
