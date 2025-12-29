import { describe, it, expect, beforeEach } from 'vitest';
import { PlanSessionManager } from '../services/planSessionManager';

describe('PlanSessionManager', () => {
    let manager: PlanSessionManager;

    beforeEach(() => {
        manager = new PlanSessionManager();
    });

    describe('basic operations', () => {
        it('should start with no plan', () => {
            expect(manager.hasPlan()).toBe(false);
            expect(manager.getPlan()).toBeUndefined();
        });

        it('should update and retrieve plan', () => {
            const plan = '## Review Plan\n- [ ] Item 1\n- [ ] Item 2';
            manager.updatePlan(plan);

            expect(manager.hasPlan()).toBe(true);
            expect(manager.getPlan()).toBe(plan);
        });

        it('should update plan multiple times', () => {
            manager.updatePlan('Initial plan');
            manager.updatePlan('Updated plan');
            manager.updatePlan('Final plan');

            expect(manager.getPlan()).toBe('Final plan');
        });

        it('should reset plan', () => {
            manager.updatePlan('Some plan');
            expect(manager.hasPlan()).toBe(true);

            manager.reset();

            expect(manager.hasPlan()).toBe(false);
            expect(manager.getPlan()).toBeUndefined();
        });
    });

    describe('per-analysis isolation', () => {
        it('should provide isolated state per instance', () => {
            const manager1 = new PlanSessionManager();
            const manager2 = new PlanSessionManager();

            manager1.updatePlan('Plan for analysis 1');
            manager2.updatePlan('Plan for analysis 2');

            expect(manager1.getPlan()).toBe('Plan for analysis 1');
            expect(manager2.getPlan()).toBe('Plan for analysis 2');
        });

        it('should not affect other instances on reset', () => {
            const manager1 = new PlanSessionManager();
            const manager2 = new PlanSessionManager();

            manager1.updatePlan('Plan 1');
            manager2.updatePlan('Plan 2');

            manager1.reset();

            expect(manager1.hasPlan()).toBe(false);
            expect(manager2.hasPlan()).toBe(true);
            expect(manager2.getPlan()).toBe('Plan 2');
        });

        it('should allow parallel analyses with separate managers', () => {
            // Simulate parallel analyses
            const chatAnalysis = new PlanSessionManager();
            const webviewAnalysis = new PlanSessionManager();

            // Both analyses update their plans independently
            chatAnalysis.updatePlan('## Chat Analysis\n- [ ] Review PR');
            webviewAnalysis.updatePlan(
                '## Webview Analysis\n- [ ] Test changes'
            );

            // Mark progress in one
            chatAnalysis.updatePlan('## Chat Analysis\n- [x] Review PR');

            // Other is unaffected
            expect(webviewAnalysis.getPlan()).toBe(
                '## Webview Analysis\n- [ ] Test changes'
            );
            expect(chatAnalysis.getPlan()).toBe(
                '## Chat Analysis\n- [x] Review PR'
            );
        });
    });

    describe('plan content', () => {
        it('should preserve markdown formatting', () => {
            const plan = `## PR Review Plan

### Overview
This PR adds authentication

### Checklist
- [ ] Review auth logic
- [ ] Check for vulnerabilities
- [x] Verify tests exist

### Notes
Found potential issue at line 42`;

            manager.updatePlan(plan);
            expect(manager.getPlan()).toBe(plan);
        });

        it('should handle empty string as valid plan', () => {
            manager.updatePlan('');

            // Empty string is still a defined plan
            expect(manager.hasPlan()).toBe(true);
            expect(manager.getPlan()).toBe('');
        });
    });
});
