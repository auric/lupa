import { describe, it, expect } from 'vitest';
import { ReasonAboutCodeTool } from '../tools/reasonAboutCodeTool';
import {
    createMockExecutionContext,
    createCancelledExecutionContext,
} from './testUtils/mockFactories';

describe('ReasonAboutCodeTool', () => {
    const tool = new ReasonAboutCodeTool();

    it('should have correct name and description', () => {
        expect(tool.name).toBe('reason_about_code');
        expect(tool.description).toContain('Analyze a specific code change');
    });

    it('should return structured analysis guidance', async () => {
        const context = createMockExecutionContext();

        const result = await tool.execute(
            {
                file: 'src/utils/auth.ts',
                change_summary: 'Added null check before token validation',
                dimensions: ['correctness', 'security'],
                observations: [
                    {
                        dimension: 'correctness',
                        observation:
                            'The null check prevents crash on undefined token',
                        risk_level: 'low',
                        needs_verification: false,
                    },
                    {
                        dimension: 'security',
                        observation:
                            'Token validation might be skipped if null check returns early',
                        risk_level: 'high',
                        needs_verification: true,
                        verification_action:
                            'read_file to check what happens after null check',
                    },
                ],
                preliminary_conclusion: 'potential_issues_need_verification',
                next_actions: [
                    'read_file auth.ts lines 10-20',
                    'find_usages validateToken',
                ],
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('Structured Code Analysis');
        expect(result.data).toContain('src/utils/auth.ts');
        expect(result.data).toContain('SECURITY');
        expect(result.data).toContain('CORRECTNESS');
        expect(result.data).toContain('🔴'); // high risk emoji
        expect(result.data).toContain('🟢'); // low risk emoji
        expect(result.data).toContain('Needs verification');
        expect(result.data).toContain('POTENTIAL ISSUES NEED VERIFICATION');
        expect(result.data).toContain('Planned Next Actions');
    });

    it('should show guiding questions for unanalyzed dimensions', async () => {
        const context = createMockExecutionContext();

        const result = await tool.execute(
            {
                file: 'src/handler.ts',
                change_summary: 'Refactored request handler',
                dimensions: ['error_handling', 'api_contract'],
                observations: [
                    {
                        dimension: 'error_handling',
                        observation: 'Error handling looks adequate',
                        risk_level: 'none',
                        needs_verification: false,
                    },
                ],
                preliminary_conclusion: 'no_issues',
                next_actions: [],
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('Dimensions Not Yet Analyzed');
        expect(result.data).toContain('api contract');
    });

    it('should advise recording findings when issues are confirmed', async () => {
        const context = createMockExecutionContext();

        const result = await tool.execute(
            {
                file: 'src/data.ts',
                change_summary: 'Changed query builder logic',
                dimensions: ['correctness'],
                observations: [
                    {
                        dimension: 'correctness',
                        observation:
                            'SQL injection possible via unsanitized input',
                        risk_level: 'high',
                        needs_verification: false,
                    },
                ],
                preliminary_conclusion: 'confirmed_issues',
                next_actions: ['record_finding for SQL injection'],
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('CONFIRMED ISSUES');
        expect(result.data).toContain('record_finding');
    });

    it('should throw CancellationError when cancelled', async () => {
        const context = createCancelledExecutionContext();

        await expect(
            tool.execute(
                {
                    file: 'test.ts',
                    change_summary: 'test',
                    dimensions: ['correctness'],
                    observations: [
                        {
                            dimension: 'correctness',
                            observation: 'test',
                            risk_level: 'none',
                            needs_verification: false,
                        },
                    ],
                    preliminary_conclusion: 'no_issues',
                    next_actions: [],
                },
                context
            )
        ).rejects.toThrow();
    });

    it('should produce valid JSON schema from Zod', () => {
        const vsTool = tool.getVSCodeTool();
        expect(vsTool.name).toBe('reason_about_code');
        expect(vsTool.inputSchema).toBeDefined();
    });
});
