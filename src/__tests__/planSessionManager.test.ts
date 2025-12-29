import { describe, it, expect, beforeEach } from 'vitest';
import { PlanSessionManager } from '../services/planSessionManager';

describe('PlanSessionManager', () => {
    let manager: PlanSessionManager;

    beforeEach(() => {
        manager = new PlanSessionManager();
    });

    describe('basic operations', () => {
        it('should return undefined when no plan exists', () => {
            expect(manager.getPlan()).toBeUndefined();
        });

        it('should return false for hasPlan when no plan exists', () => {
            expect(manager.hasPlan()).toBe(false);
        });

        it('should store and retrieve a plan', () => {
            const plan = '## Review Plan\n- [ ] Check auth\n- [ ] Verify tests';
            manager.updatePlan(plan);

            expect(manager.getPlan()).toBe(plan);
            expect(manager.hasPlan()).toBe(true);
        });

        it('should update existing plan', () => {
            manager.updatePlan('Initial plan');
            manager.updatePlan('Updated plan');

            expect(manager.getPlan()).toBe('Updated plan');
        });

        it('should reset plan state', () => {
            manager.updatePlan('Some plan');
            expect(manager.hasPlan()).toBe(true);

            manager.reset();

            expect(manager.getPlan()).toBeUndefined();
            expect(manager.hasPlan()).toBe(false);
        });
    });

    describe('session isolation', () => {
        it('should use default session initially', () => {
            expect(manager.getActiveSession()).toBe('default');
        });

        it('should allow setting active session', () => {
            manager.setActiveSession('webview-analysis-1');
            expect(manager.getActiveSession()).toBe('webview-analysis-1');
        });

        it('should isolate plans between sessions', () => {
            // Session 1 creates a plan
            manager.setActiveSession('session-1');
            manager.updatePlan('Plan for session 1');

            // Session 2 creates a different plan
            manager.setActiveSession('session-2');
            manager.updatePlan('Plan for session 2');

            // Session 1 still has its plan
            manager.setActiveSession('session-1');
            expect(manager.getPlan()).toBe('Plan for session 1');

            // Session 2 still has its plan
            manager.setActiveSession('session-2');
            expect(manager.getPlan()).toBe('Plan for session 2');
        });

        it('should return false for hasPlan in new session', () => {
            manager.setActiveSession('session-1');
            manager.updatePlan('Some plan');
            expect(manager.hasPlan()).toBe(true);

            manager.setActiveSession('session-2');
            expect(manager.hasPlan()).toBe(false);
        });

        it('should reset only active session', () => {
            manager.setActiveSession('session-1');
            manager.updatePlan('Plan 1');

            manager.setActiveSession('session-2');
            manager.updatePlan('Plan 2');

            // Reset session 2
            manager.reset();
            expect(manager.hasPlan()).toBe(false);

            // Session 1 should still have its plan
            manager.setActiveSession('session-1');
            expect(manager.getPlan()).toBe('Plan 1');
        });

        it('should reset all sessions with resetAll', () => {
            manager.setActiveSession('session-1');
            manager.updatePlan('Plan 1');

            manager.setActiveSession('session-2');
            manager.updatePlan('Plan 2');

            manager.resetAll();

            // Active session should be reset to default
            expect(manager.getActiveSession()).toBe('default');

            // Both sessions should be cleared when accessed
            manager.setActiveSession('session-1');
            expect(manager.hasPlan()).toBe(false);

            manager.setActiveSession('session-2');
            expect(manager.hasPlan()).toBe(false);
        });
    });

    describe('parallel analysis simulation', () => {
        it('should handle webview and chat participant running in parallel', () => {
            // Webview analysis starts
            manager.setActiveSession('webview-default');
            manager.reset();
            manager.updatePlan('## Webview Review\n- [ ] Auth changes');

            // Chat participant starts in parallel
            const chatSession = `chat-${Date.now()}-abc123`;
            manager.setActiveSession(chatSession);
            manager.reset();
            manager.updatePlan('## Chat Review\n- [ ] Config changes');

            // Webview continues - should still have its plan
            manager.setActiveSession('webview-default');
            expect(manager.getPlan()).toContain('Webview Review');

            // Chat continues - should still have its plan
            manager.setActiveSession(chatSession);
            expect(manager.getPlan()).toContain('Chat Review');
        });
    });
});
