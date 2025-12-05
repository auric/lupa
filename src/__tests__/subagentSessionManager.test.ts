import { describe, it, expect, beforeEach } from 'vitest';
import { SubagentSessionManager } from '../services/subagentSessionManager';
import { SubagentLimits } from '../models/toolConstants';

describe('SubagentSessionManager', () => {
    let sessionManager: SubagentSessionManager;

    beforeEach(() => {
        sessionManager = new SubagentSessionManager();
    });

    describe('Initial State', () => {
        it('should start with zero count', () => {
            expect(sessionManager.getCount()).toBe(0);
        });

        it('should allow spawning initially', () => {
            expect(sessionManager.canSpawn()).toBe(true);
        });

        it('should have full budget initially', () => {
            expect(sessionManager.getRemainingBudget()).toBe(SubagentLimits.MAX_PER_SESSION);
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
            expect(sessionManager.getRemainingBudget()).toBe(SubagentLimits.MAX_PER_SESSION - 1);
        });

        it('should track multiple spawns', () => {
            sessionManager.recordSpawn();
            sessionManager.recordSpawn();
            sessionManager.recordSpawn();
            expect(sessionManager.getCount()).toBe(3);
            expect(sessionManager.getRemainingBudget()).toBe(SubagentLimits.MAX_PER_SESSION - 3);
        });
    });

    describe('Spawn Limits', () => {
        it('should prevent spawning when limit reached', () => {
            // Spawn up to the limit
            for (let i = 0; i < SubagentLimits.MAX_PER_SESSION; i++) {
                expect(sessionManager.canSpawn()).toBe(true);
                sessionManager.recordSpawn();
            }

            // Should no longer allow spawning
            expect(sessionManager.canSpawn()).toBe(false);
            expect(sessionManager.getRemainingBudget()).toBe(0);
        });

        it('should return zero for remaining budget when exceeded', () => {
            // Spawn past the limit (even though canSpawn would return false)
            for (let i = 0; i < SubagentLimits.MAX_PER_SESSION + 2; i++) {
                sessionManager.recordSpawn();
            }

            expect(sessionManager.getRemainingBudget()).toBe(0);
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

            // IDs should restart from 1 after reset
            expect(sessionManager.recordSpawn()).toBe(1);
        });

        it('should allow spawning after reset', () => {
            // Fill up the session
            for (let i = 0; i < SubagentLimits.MAX_PER_SESSION; i++) {
                sessionManager.recordSpawn();
            }
            expect(sessionManager.canSpawn()).toBe(false);

            // Reset and verify we can spawn again
            sessionManager.reset();
            expect(sessionManager.canSpawn()).toBe(true);
            expect(sessionManager.getRemainingBudget()).toBe(SubagentLimits.MAX_PER_SESSION);
        });
    });
});
