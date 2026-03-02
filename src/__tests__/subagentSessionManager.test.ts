import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { ANALYSIS_LIMITS } from '../models/workspaceSettingsSchema';

const createMockSettings = (
    maxPerSession: number = ANALYSIS_LIMITS.maxSubagentsPerSession
): WorkspaceSettingsService =>
    ({
        getMaxSubagentsPerSession: vi.fn().mockReturnValue(maxPerSession),
    }) as unknown as WorkspaceSettingsService;

describe('SubagentSessionManager', () => {
    let sessionManager: SubagentSessionManager;
    let mockSettings: WorkspaceSettingsService;
    const defaultMax = ANALYSIS_LIMITS.maxSubagentsPerSession;

    beforeEach(() => {
        mockSettings = createMockSettings();
        sessionManager = new SubagentSessionManager(mockSettings);
    });

    describe('Initial State', () => {
        it('should start with zero count', () => {
            expect(sessionManager.getCount()).toBe(0);
        });

        it('should allow spawning initially', () => {
            expect(sessionManager.canSpawn()).toBe(true);
        });

        it('should have full budget initially', () => {
            expect(sessionManager.getRemainingBudget()).toBe(defaultMax);
        });
    });

    describe('Spawn Tracking', () => {
        it('should increment count when recording spawn', () => {
            sessionManager.recordSpawn();
            expect(sessionManager.getCount()).toBe(1);
        });

        it('should return sequential IDs starting from 1', () => {
            expect(sessionManager.recordSpawn()).toBe(1);
            expect(sessionManager.recordSpawn()).toBe(2);
            expect(sessionManager.recordSpawn()).toBe(3);
        });

        it('should decrement remaining budget when spawning', () => {
            sessionManager.recordSpawn();
            expect(sessionManager.getRemainingBudget()).toBe(defaultMax - 1);
        });

        it('should track multiple spawns', () => {
            sessionManager.recordSpawn();
            sessionManager.recordSpawn();
            sessionManager.recordSpawn();
            expect(sessionManager.getCount()).toBe(3);
            expect(sessionManager.getRemainingBudget()).toBe(defaultMax - 3);
        });
    });

    describe('Spawn Limits', () => {
        it('should prevent spawning when limit reached', () => {
            for (let i = 0; i < defaultMax; i++) {
                expect(sessionManager.canSpawn()).toBe(true);
                sessionManager.recordSpawn();
            }

            expect(sessionManager.canSpawn()).toBe(false);
            expect(sessionManager.getRemainingBudget()).toBe(0);
        });

        it('should return zero for remaining budget when exceeded', () => {
            for (let i = 0; i < defaultMax + 2; i++) {
                sessionManager.recordSpawn();
            }
            expect(sessionManager.getRemainingBudget()).toBe(0);
        });

        it('should respect custom limit from settings', () => {
            const customLimit = 3;
            mockSettings = createMockSettings(customLimit);
            sessionManager = new SubagentSessionManager(mockSettings);

            for (let i = 0; i < customLimit; i++) {
                expect(sessionManager.canSpawn()).toBe(true);
                sessionManager.recordSpawn();
            }
            expect(sessionManager.canSpawn()).toBe(false);
        });
    });

    describe('Rollback', () => {
        it('should decrement count on rollback', () => {
            sessionManager.recordSpawn();
            sessionManager.recordSpawn();
            sessionManager.rollbackSpawn();
            expect(sessionManager.getCount()).toBe(1);
        });

        it('should restore remaining budget on rollback', () => {
            sessionManager.recordSpawn();
            sessionManager.rollbackSpawn();
            expect(sessionManager.getRemainingBudget()).toBe(defaultMax);
        });

        it('should re-allow spawning after rollback from limit', () => {
            for (let i = 0; i < defaultMax; i++) {
                sessionManager.recordSpawn();
            }
            expect(sessionManager.canSpawn()).toBe(false);

            sessionManager.rollbackSpawn();
            expect(sessionManager.canSpawn()).toBe(true);
        });

        it('should not decrement below zero', () => {
            sessionManager.rollbackSpawn();
            expect(sessionManager.getCount()).toBe(0);
            expect(sessionManager.getRemainingBudget()).toBe(defaultMax);
        });

        it('should not reuse IDs after rollback', () => {
            const id1 = sessionManager.recordSpawn();
            const id2 = sessionManager.recordSpawn();
            sessionManager.rollbackSpawn();
            const id3 = sessionManager.recordSpawn();
            expect(id3).toBeGreaterThan(id2);
            expect(new Set([id1, id2, id3]).size).toBe(3);
        });
    });

    describe('Reset', () => {
        it('should reset count to zero', () => {
            sessionManager.recordSpawn();
            sessionManager.recordSpawn();
            sessionManager.reset();
            expect(sessionManager.getCount()).toBe(0);
        });

        it('should reset IDs after reset', () => {
            sessionManager.recordSpawn();
            sessionManager.recordSpawn();
            sessionManager.reset();
            expect(sessionManager.recordSpawn()).toBe(1);
        });

        it('should allow spawning after reset', () => {
            for (let i = 0; i < defaultMax; i++) {
                sessionManager.recordSpawn();
            }
            expect(sessionManager.canSpawn()).toBe(false);

            sessionManager.reset();
            expect(sessionManager.canSpawn()).toBe(true);
            expect(sessionManager.getRemainingBudget()).toBe(defaultMax);
        });
    });
});
