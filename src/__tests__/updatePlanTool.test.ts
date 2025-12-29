import { describe, it, expect, beforeEach } from 'vitest';
import { UpdatePlanTool } from '../tools/updatePlanTool';
import { PlanSessionManager } from '../services/planSessionManager';

describe('UpdatePlanTool', () => {
    let tool: UpdatePlanTool;
    let planManager: PlanSessionManager;

    beforeEach(() => {
        planManager = new PlanSessionManager();
        tool = new UpdatePlanTool(planManager);
    });

    describe('tool metadata', () => {
        it('should have correct name', () => {
            expect(tool.name).toBe('update_plan');
        });

        it('should have description explaining purpose', () => {
            expect(tool.description).toContain('review plan');
            expect(tool.description).toContain('track progress');
        });

        it('should have schema with plan parameter', () => {
            const shape = tool.schema.shape;
            expect(shape).toHaveProperty('plan');
        });
    });

    describe('execute', () => {
        it('should create initial plan successfully', async () => {
            const plan =
                '## Review Plan\n- [ ] Check authentication\n- [ ] Verify tests';

            const result = await tool.execute({ plan });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Review plan created');
            expect(result.data).toContain(plan);
        });

        it('should report update when plan already exists', async () => {
            const initialPlan = '## Initial Plan\n- [ ] First task';
            await tool.execute({ plan: initialPlan });

            const updatedPlan = '## Initial Plan\n- [x] First task';
            const result = await tool.execute({ plan: updatedPlan });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Plan updated successfully');
            expect(result.data).toContain('- [x] First task');
        });

        it('should store plan in manager', async () => {
            const plan = '## Test Plan\n- [ ] Verify functionality';

            await tool.execute({ plan });

            expect(planManager.hasPlan()).toBe(true);
            expect(planManager.getPlan()).toBe(plan);
        });

        it('should include next steps guidance', async () => {
            const plan = '## Plan\n- [ ] Task 1';

            const result = await tool.execute({ plan });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Next Steps');
            expect(result.data).toContain('think_about_completion');
        });
    });

    describe('schema validation', () => {
        it('should reject plan shorter than 10 characters', () => {
            const parseResult = tool.schema.safeParse({ plan: 'short' });
            expect(parseResult.success).toBe(false);
        });

        it('should accept plan with 10+ characters', () => {
            const parseResult = tool.schema.safeParse({
                plan: '0123456789',
            });
            expect(parseResult.success).toBe(true);
        });

        it('should reject missing plan parameter', () => {
            const parseResult = tool.schema.safeParse({});
            expect(parseResult.success).toBe(false);
        });
    });

    describe('session isolation', () => {
        it('should respect active session in manager', async () => {
            // Session 1
            planManager.setActiveSession('session-1');
            await tool.execute({ plan: 'Plan for session 1' });

            // Session 2
            planManager.setActiveSession('session-2');
            const result = await tool.execute({
                plan: 'Plan for session 2',
            });

            // Result should indicate "created" not "updated" since session-2 is new
            expect(result.success).toBe(true);
            expect(result.data).toContain('Review plan created');

            // Verify isolation
            planManager.setActiveSession('session-1');
            expect(planManager.getPlan()).toBe('Plan for session 1');

            planManager.setActiveSession('session-2');
            expect(planManager.getPlan()).toBe('Plan for session 2');
        });
    });
});
