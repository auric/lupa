import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import { WorkspaceSettingsService } from '../services/workspaceSettingsService';
import { SUBAGENT_LIMITS } from '../models/workspaceSettingsSchema';

const createMockSettings = (
    maxPerSession: number = SUBAGENT_LIMITS.maxPerSession.default
): WorkspaceSettingsService =>
    ({
        getMaxSubagentsPerSession: vi.fn().mockReturnValue(maxPerSession),
    }) as unknown as WorkspaceSettingsService;

describe('SubagentSessionManager', () => {
    let sessionManager: SubagentSessionManager;
    let mockSettings: WorkspaceSettingsService;
    const defaultMax = SUBAGENT_LIMITS.maxPerSession.default;

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
