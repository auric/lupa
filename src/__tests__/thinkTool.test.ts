import { describe, it, expect } from 'vitest';
import { ThinkTool } from '../tools/thinkTool';
import {
    createMockExecutionContext,
    createCancelledExecutionContext,
} from './testUtils/mockFactories';

describe('ThinkTool', () => {
    const tool = new ThinkTool();

    it('should have correct name and description', () => {
        expect(tool.name).toBe('think');
        expect(tool.description).toContain('step-by-step reasoning');
    });

    it('should return analysis guidance with topic heading', async () => {
        const context = createMockExecutionContext();

        const result = await tool.execute(
            {
                topic: 'auth changes in login.ts',
                analysis:
                    'Added null check before token validation. The early return might skip validation entirely.',
                identified_risks: [
                    'Token validation could be bypassed if null check returns early',
                    'Error path not tested',
                ],
                next_action:
                    'Use find_usages to check callers of validateToken',
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('auth changes in login.ts');
        expect(result.data).toContain('Token validation could be bypassed');
        expect(result.data).toContain('Error path not tested');
        expect(result.data).toContain(
            'Use find_usages to check callers of validateToken'
        );
    });

    it('should omit risks section when no risks identified', async () => {
        const context = createMockExecutionContext();

        const result = await tool.execute(
            {
                topic: 'refactoring handler.ts',
                analysis:
                    'Refactored to use async/await, no functional change detected.',
                identified_risks: [],
                next_action: 'Move to the next file in the diff',
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).not.toContain('Identified Risks');
        expect(result.data).toContain('Move to the next file');
    });

    it('should include risk count when risks present', async () => {
        const context = createMockExecutionContext();

        const result = await tool.execute(
            {
                topic: 'SQL query builder',
                analysis: 'Input is concatenated into SQL string directly',
                identified_risks: ['SQL injection via unsanitized input'],
                next_action: 'Record finding with record_finding tool',
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('Identified Risks (1)');
        expect(result.data).toContain('⚠️');
    });

    it('should throw CancellationError when cancelled', async () => {
        const context = createCancelledExecutionContext();

        await expect(
            tool.execute(
                {
                    topic: 'test',
                    analysis: 'test',
                    identified_risks: [],
                    next_action: 'test',
                },
                context
            )
        ).rejects.toThrow();
    });

    it('should produce valid JSON schema from Zod', () => {
        const vsTool = tool.getVSCodeTool();
        expect(vsTool.name).toBe('think');
        expect(vsTool.inputSchema).toBeDefined();
    });

    it('should strip unexpected parameters (non-strict mode)', () => {
        const parsed = tool.schema.safeParse({
            topic: 'test',
            analysis: 'test analysis',
            identified_risks: [],
            next_action: 'continue',
            extra_field: 'not allowed',
        });
        expect(parsed.success).toBe(true);
    });

    it('should accept valid input with all required fields', () => {
        const parsed = tool.schema.safeParse({
            topic: 'auth changes',
            analysis: 'Reviewed the token handling logic',
            identified_risks: ['potential race condition'],
            next_action: 'check with find_usages',
        });
        expect(parsed.success).toBe(true);
    });

    it('should reject missing required fields', () => {
        const parsed = tool.schema.safeParse({});
        expect(parsed.success).toBe(false);
    });
});
