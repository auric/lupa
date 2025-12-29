import { describe, it, expect, beforeEach } from 'vitest';
import { UpdatePlanTool } from '../tools/updatePlanTool';
import { PlanSessionManager } from '../services/planSessionManager';
import { ExecutionContext } from '../types/executionContext';

describe('UpdatePlanTool', () => {
    let tool: UpdatePlanTool;
    let planManager: PlanSessionManager;
    let executionContext: ExecutionContext;

    beforeEach(() => {
        planManager = new PlanSessionManager();
        executionContext = { planManager };

        tool = new UpdatePlanTool();
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

            const result = await tool.execute({ plan }, executionContext);

            expect(result.success).toBe(true);
            expect(result.data).toContain('Review plan created');
            expect(result.data).toContain(plan);
        });

        it('should report update when plan already exists', async () => {
            const initialPlan = '## Initial Plan\n- [ ] First task';
            await tool.execute({ plan: initialPlan }, executionContext);

            const updatedPlan = '## Initial Plan\n- [x] First task';
            const result = await tool.execute(
                { plan: updatedPlan },
                executionContext
            );

            expect(result.success).toBe(true);
            expect(result.data).toContain('Plan updated successfully');
            expect(result.data).toContain('- [x] First task');
        });

        it('should store plan in manager', async () => {
            const plan = '## Test Plan\n- [ ] Verify functionality';

            await tool.execute({ plan }, executionContext);

            expect(planManager.hasPlan()).toBe(true);
            expect(planManager.getPlan()).toBe(plan);
        });

        it('should include next steps guidance', async () => {
            const plan = '## Plan\n- [ ] Task 1';

            const result = await tool.execute({ plan }, executionContext);

            expect(result.success).toBe(true);
            expect(result.data).toContain('Next Steps');
            expect(result.data).toContain('think_about_completion');
        });

        it('should return error when no active analysis session', async () => {
            // No context provided - simulates no active session
            const result = await tool.execute({
                plan: '## Plan\n- [ ] Task',
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('No active analysis session');
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

    describe('per-analysis isolation', () => {
        it('should use plan manager from current analysis context', async () => {
            // First analysis with its own context
            const manager1 = new PlanSessionManager();
            const context1: ExecutionContext = { planManager: manager1 };
            await tool.execute({ plan: 'Plan for analysis 1' }, context1);

            // Second analysis with different context
            const manager2 = new PlanSessionManager();
            const context2: ExecutionContext = { planManager: manager2 };
            const result = await tool.execute(
                { plan: 'Plan for analysis 2' },
                context2
            );

            // Should show "created" not "updated" since it's a new context
            expect(result.success).toBe(true);
            expect(result.data).toContain('Review plan created');

            // Each manager has its own plan
            expect(manager1.getPlan()).toBe('Plan for analysis 1');
            expect(manager2.getPlan()).toBe('Plan for analysis 2');
        });
    });
});
