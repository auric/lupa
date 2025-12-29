import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UpdatePlanTool } from '../tools/updatePlanTool';
import { PlanSessionManager } from '../services/planSessionManager';
import { ToolExecutor } from '../models/toolExecutor';

describe('UpdatePlanTool', () => {
    let tool: UpdatePlanTool;
    let planManager: PlanSessionManager;
    let mockToolExecutor: ToolExecutor;

    beforeEach(() => {
        planManager = new PlanSessionManager();

        // Create mock ToolExecutor that returns our planManager
        mockToolExecutor = {
            getCurrentPlanManager: vi.fn().mockReturnValue(planManager),
            setCurrentPlanManager: vi.fn(),
            clearCurrentPlanManager: vi.fn(),
        } as unknown as ToolExecutor;

        tool = new UpdatePlanTool(mockToolExecutor);
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

        it('should return error when no active analysis session', async () => {
            // ToolExecutor returns undefined - no active session
            vi.mocked(mockToolExecutor.getCurrentPlanManager).mockReturnValue(
                undefined
            );

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
            // First analysis
            const manager1 = new PlanSessionManager();
            vi.mocked(mockToolExecutor.getCurrentPlanManager).mockReturnValue(
                manager1
            );
            await tool.execute({ plan: 'Plan for analysis 1' });

            // Second analysis with different manager
            const manager2 = new PlanSessionManager();
            vi.mocked(mockToolExecutor.getCurrentPlanManager).mockReturnValue(
                manager2
            );
            const result = await tool.execute({ plan: 'Plan for analysis 2' });

            // Should show "created" not "updated" since it's a new context
            expect(result.success).toBe(true);
            expect(result.data).toContain('Review plan created');

            // Each manager has its own plan
            expect(manager1.getPlan()).toBe('Plan for analysis 1');
            expect(manager2.getPlan()).toBe('Plan for analysis 2');
        });
    });
});
