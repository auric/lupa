import { describe, it, expect } from 'vitest';
import { ThinkAboutCodeChangeTool } from '../tools/thinkAboutCodeChangeTool';
import {
    createMockExecutionContext,
    createCancelledExecutionContext,
} from './testUtils/mockFactories';

describe('ThinkAboutCodeChangeTool', () => {
    const tool = new ThinkAboutCodeChangeTool();

    it('should have correct name and description', () => {
        expect(tool.name).toBe('think_about_code_change');
        expect(tool.description).toContain('Think out loud');
    });

    it('should return analysis guidance for needs_investigation verdict', async () => {
        const context = createMockExecutionContext();

        const result = await tool.execute(
            {
                file: 'src/utils/auth.ts',
                analysis:
                    'Added null check before token validation. The early return might skip validation entirely.',
                identified_risks: [
                    'Token validation could be bypassed if null check returns early',
                    'Error path not tested',
                ],
                verdict: 'needs_investigation',
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('src/utils/auth.ts');
        expect(result.data).toContain('Token validation could be bypassed');
        expect(result.data).toContain('NEEDS INVESTIGATION');
        expect(result.data).toContain('find_symbol');
    });

    it('should return guidance for likely_issue verdict', async () => {
        const context = createMockExecutionContext();

        const result = await tool.execute(
            {
                file: 'src/data.ts',
                analysis: 'SQL injection possible via unsanitized input',
                identified_risks: ['SQL injection'],
                verdict: 'likely_issue',
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('LIKELY ISSUE');
        expect(result.data).toContain('record_finding');
        expect(result.data).toContain('disprove');
    });

    it('should return guidance for no_issues verdict', async () => {
        const context = createMockExecutionContext();

        const result = await tool.execute(
            {
                file: 'src/handler.ts',
                analysis: 'Refactored to use async/await, no functional change',
                identified_risks: [],
                verdict: 'no_issues',
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('NO ISSUES');
        expect(result.data).toContain('Move to the next file');
        expect(result.data).not.toContain('Identified Risks');
    });

    it('should throw CancellationError when cancelled', async () => {
        const context = createCancelledExecutionContext();

        await expect(
            tool.execute(
                {
                    file: 'test.ts',
                    analysis: 'test',
                    identified_risks: [],
                    verdict: 'no_issues',
                },
                context
            )
        ).rejects.toThrow();
    });

    it('should produce valid JSON schema from Zod', () => {
        const vsTool = tool.getVSCodeTool();
        expect(vsTool.name).toBe('think_about_code_change');
        expect(vsTool.inputSchema).toBeDefined();
    });
});
