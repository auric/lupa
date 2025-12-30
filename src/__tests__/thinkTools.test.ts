import { describe, it, expect, beforeEach } from 'vitest';
import { ThinkAboutContextTool } from '../tools/thinkAboutContextTool';
import { ThinkAboutTaskTool } from '../tools/thinkAboutTaskTool';
import { ThinkAboutCompletionTool } from '../tools/thinkAboutCompletionTool';
import { ThinkAboutInvestigationTool } from '../tools/thinkAboutInvestigationTool';

describe('ThinkAboutContextTool', () => {
    let tool: ThinkAboutContextTool;

    beforeEach(() => {
        tool = new ThinkAboutContextTool();
    });

    describe('Tool Configuration', () => {
        it('should have correct name', () => {
            expect(tool.name).toBe('think_about_context');
        });

        it('should have meaningful description', () => {
            expect(tool.description).toContain('Articulate');
            expect(tool.description).toContain('context');
        });

        it('should generate valid VS Code tool configuration', () => {
            const vscodeTool = tool.getVSCodeTool();
            expect(vscodeTool.name).toBe('think_about_context');
            expect(vscodeTool.description).toBeDefined();
            expect(vscodeTool.inputSchema).toBeDefined();
        });
    });

    describe('Schema Validation', () => {
        it('should accept valid input with all required fields', () => {
            const parsed = tool.schema.safeParse({
                files_examined: ['src/auth.ts', 'src/utils.ts'],
                key_findings: ['Found potential race condition'],
                remaining_gaps: ['Need to check error handling'],
                decision: 'need_more_context',
            });
            expect(parsed.success).toBe(true);
        });

        it('should accept empty arrays for key_findings and remaining_gaps', () => {
            const parsed = tool.schema.safeParse({
                files_examined: ['src/main.ts'],
                key_findings: [],
                remaining_gaps: [],
                decision: 'context_sufficient',
            });
            expect(parsed.success).toBe(true);
        });

        it('should reject empty files_examined array', () => {
            const parsed = tool.schema.safeParse({
                files_examined: [],
                key_findings: [],
                remaining_gaps: [],
                decision: 'context_sufficient',
            });
            expect(parsed.success).toBe(false);
        });

        it('should reject missing required fields', () => {
            const parsed = tool.schema.safeParse({});
            expect(parsed.success).toBe(false);
        });

        it('should reject unexpected parameters in strict mode', () => {
            const parsed = tool.schema.safeParse({
                files_examined: ['src/auth.ts'],
                key_findings: [],
                remaining_gaps: [],
                decision: 'context_sufficient',
                unexpected: 'value',
            });
            expect(parsed.success).toBe(false);
        });

        it('should reject invalid decision values', () => {
            const parsed = tool.schema.safeParse({
                files_examined: ['src/auth.ts'],
                key_findings: [],
                remaining_gaps: [],
                decision: 'invalid_decision',
            });
            expect(parsed.success).toBe(false);
        });

        it('should accept all valid decision values', () => {
            const decisions = [
                'need_more_context',
                'need_subagent',
                'context_sufficient',
            ];
            for (const decision of decisions) {
                const parsed = tool.schema.safeParse({
                    files_examined: ['src/file.ts'],
                    key_findings: [],
                    remaining_gaps: [],
                    decision,
                });
                expect(parsed.success).toBe(true);
            }
        });
    });

    describe('Execution', () => {
        it('should return guidance reflecting files examined', async () => {
            const result = await tool.execute({
                files_examined: ['src/auth.ts', 'src/utils.ts'],
                key_findings: [],
                remaining_gaps: [],
                decision: 'context_sufficient',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Files/Symbols Examined');
            expect(result.data).toContain('src/auth.ts');
            expect(result.data).toContain('src/utils.ts');
        });

        it('should include key findings when provided', async () => {
            const result = await tool.execute({
                files_examined: ['src/auth.ts'],
                key_findings: [
                    'Found race condition in login flow',
                    'Missing error handling',
                ],
                remaining_gaps: [],
                decision: 'context_sufficient',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Key Findings');
            expect(result.data).toContain('Found race condition in login flow');
            expect(result.data).toContain('Missing error handling');
        });

        it('should include remaining gaps when provided', async () => {
            const result = await tool.execute({
                files_examined: ['src/auth.ts'],
                key_findings: [],
                remaining_gaps: [
                    'Need to check session handling',
                    'Verify token expiration',
                ],
                decision: 'need_more_context',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Remaining Gaps');
            expect(result.data).toContain('Need to check session handling');
            expect(result.data).toContain('Verify token expiration');
        });

        it('should provide guidance for need_more_context decision', async () => {
            const result = await tool.execute({
                files_examined: ['src/auth.ts'],
                key_findings: [],
                remaining_gaps: ['Check error handling'],
                decision: 'need_more_context',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Decision: NEED MORE CONTEXT');
            expect(result.data).toContain('find_symbol');
            expect(result.data).toContain('find_usages');
        });

        it('should provide guidance for need_subagent decision', async () => {
            const result = await tool.execute({
                files_examined: ['src/auth.ts'],
                key_findings: ['Complex security flow'],
                remaining_gaps: ['Deep security analysis needed'],
                decision: 'need_subagent',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Decision: NEED SUBAGENT');
            expect(result.data).toContain('subagent');
            expect(result.data).toContain('security analysis');
        });

        it('should provide guidance for context_sufficient decision', async () => {
            const result = await tool.execute({
                files_examined: ['src/auth.ts', 'src/utils.ts'],
                key_findings: ['Auth flow is secure'],
                remaining_gaps: [],
                decision: 'context_sufficient',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Decision: CONTEXT SUFFICIENT');
            expect(result.data).toContain('think_about_task');
        });

        it('should include Markdown structure', async () => {
            const result = await tool.execute({
                files_examined: ['src/auth.ts'],
                key_findings: [],
                remaining_gaps: [],
                decision: 'context_sufficient',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('##');
            expect(result.data).toContain('###');
        });
    });
});

describe('ThinkAboutTaskTool', () => {
    let tool: ThinkAboutTaskTool;

    beforeEach(() => {
        tool = new ThinkAboutTaskTool();
    });

    describe('Tool Configuration', () => {
        it('should have correct name', () => {
            expect(tool.name).toBe('think_about_task');
        });

        it('should have meaningful description', () => {
            expect(tool.description).toContain('Articulate');
            expect(tool.description).toContain('analysis');
        });

        it('should generate valid VS Code tool configuration', () => {
            const vscodeTool = tool.getVSCodeTool();
            expect(vscodeTool.name).toBe('think_about_task');
            expect(vscodeTool.description).toBeDefined();
        });
    });

    describe('Schema Validation', () => {
        it('should accept valid input with all required fields', () => {
            const parsed = tool.schema.safeParse({
                analysis_focus: 'Authentication changes in auth.ts',
                issues_found: [
                    {
                        description: 'Missing null check',
                        file: 'src/auth.ts',
                        severity: 'high',
                    },
                ],
                areas_needing_investigation: ['Error handling paths'],
                positive_observations: ['Good use of TypeScript'],
                decision: 'gaps_in_coverage',
            });
            expect(parsed.success).toBe(true);
        });

        it('should accept empty arrays', () => {
            const parsed = tool.schema.safeParse({
                analysis_focus: 'API changes',
                issues_found: [],
                areas_needing_investigation: [],
                positive_observations: [],
                decision: 'ready_to_synthesize',
            });
            expect(parsed.success).toBe(true);
        });

        it('should reject missing required fields', () => {
            const parsed = tool.schema.safeParse({});
            expect(parsed.success).toBe(false);
        });

        it('should reject invalid severity values', () => {
            const parsed = tool.schema.safeParse({
                analysis_focus: 'Test',
                issues_found: [
                    {
                        description: 'Issue',
                        file: 'src/file.ts',
                        severity: 'super_high',
                    },
                ],
                areas_needing_investigation: [],
                positive_observations: [],
                decision: 'ready_to_synthesize',
            });
            expect(parsed.success).toBe(false);
        });

        it('should accept all valid severity values', () => {
            const severities = ['critical', 'high', 'medium', 'low'];
            for (const severity of severities) {
                const parsed = tool.schema.safeParse({
                    analysis_focus: 'Test',
                    issues_found: [
                        { description: 'Issue', file: 'src/file.ts', severity },
                    ],
                    areas_needing_investigation: [],
                    positive_observations: [],
                    decision: 'ready_to_synthesize',
                });
                expect(parsed.success).toBe(true);
            }
        });

        it('should accept all valid decision values', () => {
            const decisions = [
                'off_track',
                'gaps_in_coverage',
                'ready_to_synthesize',
            ];
            for (const decision of decisions) {
                const parsed = tool.schema.safeParse({
                    analysis_focus: 'Test',
                    issues_found: [],
                    areas_needing_investigation: [],
                    positive_observations: [],
                    decision,
                });
                expect(parsed.success).toBe(true);
            }
        });

        it('should reject unexpected parameters in strict mode', () => {
            const parsed = tool.schema.safeParse({
                analysis_focus: 'Test',
                issues_found: [],
                areas_needing_investigation: [],
                positive_observations: [],
                decision: 'ready_to_synthesize',
                extra_field: 'not allowed',
            });
            expect(parsed.success).toBe(false);
        });
    });

    describe('Execution', () => {
        it('should return guidance reflecting analysis focus', async () => {
            const result = await tool.execute({
                analysis_focus: 'Authentication changes in auth.ts',
                issues_found: [],
                areas_needing_investigation: [],
                positive_observations: [],
                decision: 'ready_to_synthesize',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Current Focus');
            expect(result.data).toContain('Authentication changes in auth.ts');
        });

        it('should format issues with severity emojis', async () => {
            const result = await tool.execute({
                analysis_focus: 'Security review',
                issues_found: [
                    {
                        description: 'SQL injection vulnerability',
                        file: 'src/db.ts',
                        severity: 'critical',
                    },
                    {
                        description: 'Missing input validation',
                        file: 'src/api.ts',
                        severity: 'high',
                    },
                    {
                        description: 'Unused variable',
                        file: 'src/utils.ts',
                        severity: 'low',
                    },
                ],
                areas_needing_investigation: [],
                positive_observations: [],
                decision: 'gaps_in_coverage',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('🔴');
            expect(result.data).toContain('CRITICAL');
            expect(result.data).toContain('SQL injection vulnerability');
            expect(result.data).toContain('🟠');
            expect(result.data).toContain('HIGH');
            expect(result.data).toContain('🟢');
            expect(result.data).toContain('LOW');
        });

        it('should include positive observations when provided', async () => {
            const result = await tool.execute({
                analysis_focus: 'Code quality',
                issues_found: [],
                areas_needing_investigation: [],
                positive_observations: [
                    'Good error handling',
                    'Clear naming conventions',
                ],
                decision: 'ready_to_synthesize',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Positive Observations');
            expect(result.data).toContain('Good error handling');
            expect(result.data).toContain('Clear naming conventions');
            expect(result.data).toContain('✓');
        });

        it('should provide guidance for off_track decision', async () => {
            const result = await tool.execute({
                analysis_focus: 'Investigating unrelated module',
                issues_found: [],
                areas_needing_investigation: [],
                positive_observations: [],
                decision: 'off_track',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Decision: OFF TRACK');
            expect(result.data).toContain('Refocus');
        });

        it('should provide guidance for gaps_in_coverage decision', async () => {
            const result = await tool.execute({
                analysis_focus: 'API review',
                issues_found: [],
                areas_needing_investigation: ['Error paths', 'Edge cases'],
                positive_observations: [],
                decision: 'gaps_in_coverage',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Decision: GAPS IN COVERAGE');
            expect(result.data).toContain('Continue analysis');
        });

        it('should provide guidance for ready_to_synthesize decision', async () => {
            const result = await tool.execute({
                analysis_focus: 'Complete review',
                issues_found: [],
                areas_needing_investigation: [],
                positive_observations: ['Well-structured code'],
                decision: 'ready_to_synthesize',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Decision: READY TO SYNTHESIZE');
            expect(result.data).toContain('think_about_completion');
        });
    });
});

describe('ThinkAboutCompletionTool', () => {
    let tool: ThinkAboutCompletionTool;

    beforeEach(() => {
        tool = new ThinkAboutCompletionTool();
    });

    describe('Tool Configuration', () => {
        it('should have correct name', () => {
            expect(tool.name).toBe('think_about_completion');
        });

        it('should have meaningful description', () => {
            expect(tool.description).toContain('completeness');
            expect(tool.description).toContain('submitting');
        });

        it('should generate valid VS Code tool configuration', () => {
            const vscodeTool = tool.getVSCodeTool();
            expect(vscodeTool.name).toBe('think_about_completion');
            expect(vscodeTool.description).toBeDefined();
        });
    });

    describe('Schema Validation', () => {
        it('should accept valid input with all required fields', () => {
            const parsed = tool.schema.safeParse({
                summary_draft:
                    'This PR adds authentication support with OAuth2 integration.',
                critical_issues_count: 0,
                high_issues_count: 1,
                files_analyzed: ['src/auth.ts', 'src/oauth.ts'],
                files_in_diff: 3,
                recommendation: 'approve_with_suggestions',
                decision: 'ready_to_submit',
            });
            expect(parsed.success).toBe(true);
        });

        it('should reject summary_draft shorter than 20 characters', () => {
            const parsed = tool.schema.safeParse({
                summary_draft: 'Too short',
                critical_issues_count: 0,
                high_issues_count: 0,
                files_analyzed: ['src/file.ts'],
                files_in_diff: 1,
                recommendation: 'approve',
                decision: 'ready_to_submit',
            });
            expect(parsed.success).toBe(false);
        });

        it('should reject empty files_analyzed array', () => {
            const parsed = tool.schema.safeParse({
                summary_draft: 'This is a valid summary that is long enough.',
                critical_issues_count: 0,
                high_issues_count: 0,
                files_analyzed: [],
                files_in_diff: 1,
                recommendation: 'approve',
                decision: 'ready_to_submit',
            });
            expect(parsed.success).toBe(false);
        });

        it('should reject files_in_diff less than 1', () => {
            const parsed = tool.schema.safeParse({
                summary_draft: 'This is a valid summary that is long enough.',
                critical_issues_count: 0,
                high_issues_count: 0,
                files_analyzed: ['src/file.ts'],
                files_in_diff: 0,
                recommendation: 'approve',
                decision: 'ready_to_submit',
            });
            expect(parsed.success).toBe(false);
        });

        it('should reject negative issue counts', () => {
            const parsed = tool.schema.safeParse({
                summary_draft: 'This is a valid summary that is long enough.',
                critical_issues_count: -1,
                high_issues_count: 0,
                files_analyzed: ['src/file.ts'],
                files_in_diff: 1,
                recommendation: 'approve',
                decision: 'ready_to_submit',
            });
            expect(parsed.success).toBe(false);
        });

        it('should accept all valid recommendation values', () => {
            const recommendations = [
                'approve',
                'approve_with_suggestions',
                'request_changes',
                'block_merge',
            ];
            for (const recommendation of recommendations) {
                const parsed = tool.schema.safeParse({
                    summary_draft:
                        'This is a valid summary that is long enough.',
                    critical_issues_count: 0,
                    high_issues_count: 0,
                    files_analyzed: ['src/file.ts'],
                    files_in_diff: 1,
                    recommendation,
                    decision: 'ready_to_submit',
                });
                expect(parsed.success).toBe(true);
            }
        });

        it('should accept all valid decision values', () => {
            const decisions = ['needs_work', 'ready_to_submit'];
            for (const decision of decisions) {
                const parsed = tool.schema.safeParse({
                    summary_draft:
                        'This is a valid summary that is long enough.',
                    critical_issues_count: 0,
                    high_issues_count: 0,
                    files_analyzed: ['src/file.ts'],
                    files_in_diff: 1,
                    recommendation: 'approve',
                    decision,
                });
                expect(parsed.success).toBe(true);
            }
        });

        it('should reject missing required fields', () => {
            const parsed = tool.schema.safeParse({});
            expect(parsed.success).toBe(false);
        });

        it('should reject unexpected parameters in strict mode', () => {
            const parsed = tool.schema.safeParse({
                summary_draft: 'This is a valid summary that is long enough.',
                critical_issues_count: 0,
                high_issues_count: 0,
                files_analyzed: ['src/file.ts'],
                files_in_diff: 1,
                recommendation: 'approve',
                decision: 'ready_to_submit',
                extra: 'not allowed',
            });
            expect(parsed.success).toBe(false);
        });
    });

    describe('Execution', () => {
        it('should return guidance reflecting summary draft', async () => {
            const result = await tool.execute({
                summary_draft:
                    'This PR refactors the authentication module for better security.',
                critical_issues_count: 0,
                high_issues_count: 0,
                files_analyzed: ['src/auth.ts'],
                files_in_diff: 1,
                recommendation: 'approve',
                decision: 'ready_to_submit',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Summary Draft');
            expect(result.data).toContain(
                'This PR refactors the authentication module'
            );
        });

        it('should show issue counts with emojis', async () => {
            const result = await tool.execute({
                summary_draft:
                    'This PR has some issues that need to be addressed.',
                critical_issues_count: 2,
                high_issues_count: 3,
                files_analyzed: ['src/auth.ts', 'src/api.ts'],
                files_in_diff: 2,
                recommendation: 'request_changes',
                decision: 'ready_to_submit',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('🔴 Critical: 2');
            expect(result.data).toContain('🟠 High: 3');
        });

        it('should calculate and show coverage percentage', async () => {
            const result = await tool.execute({
                summary_draft: 'Partial review of the authentication changes.',
                critical_issues_count: 0,
                high_issues_count: 0,
                files_analyzed: ['src/auth.ts', 'src/oauth.ts'],
                files_in_diff: 4,
                recommendation: 'approve_with_suggestions',
                decision: 'needs_work',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Coverage');
            expect(result.data).toContain('2/4');
            expect(result.data).toContain('50%');
            expect(result.data).toContain('Not all files analyzed');
        });

        it('should warn about critical issues affecting recommendation', async () => {
            const result = await tool.execute({
                summary_draft:
                    'Found critical security vulnerabilities in this PR.',
                critical_issues_count: 1,
                high_issues_count: 0,
                files_analyzed: ['src/auth.ts'],
                files_in_diff: 1,
                recommendation: 'block_merge',
                decision: 'ready_to_submit',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Critical issues found');
            expect(result.data).toContain('block_merge');
        });

        it('should provide guidance for needs_work decision', async () => {
            const result = await tool.execute({
                summary_draft:
                    'Need to analyze more files before completing review.',
                critical_issues_count: 0,
                high_issues_count: 0,
                files_analyzed: ['src/auth.ts'],
                files_in_diff: 3,
                recommendation: 'approve',
                decision: 'needs_work',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Decision: NEEDS WORK');
            expect(result.data).toContain('Address gaps');
            expect(result.data).toContain('2 file(s)');
        });

        it('should provide guidance for ready_to_submit decision', async () => {
            const result = await tool.execute({
                summary_draft:
                    'Comprehensive review completed with no blocking issues.',
                critical_issues_count: 0,
                high_issues_count: 0,
                files_analyzed: ['src/auth.ts', 'src/utils.ts'],
                files_in_diff: 2,
                recommendation: 'approve',
                decision: 'ready_to_submit',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Decision: READY TO SUBMIT');
            expect(result.data).toContain('submit_review');
            expect(result.data).toContain('Markdown formatting');
        });

        it('should show recommendation in output', async () => {
            const result = await tool.execute({
                summary_draft:
                    'This PR makes good improvements but has suggestions.',
                critical_issues_count: 0,
                high_issues_count: 1,
                files_analyzed: ['src/auth.ts'],
                files_in_diff: 1,
                recommendation: 'approve_with_suggestions',
                decision: 'ready_to_submit',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain(
                'Recommendation: APPROVE WITH SUGGESTIONS'
            );
        });
    });
});

describe('ThinkAboutInvestigationTool', () => {
    let tool: ThinkAboutInvestigationTool;

    beforeEach(() => {
        tool = new ThinkAboutInvestigationTool();
    });

    describe('Tool Configuration', () => {
        it('should have correct name', () => {
            expect(tool.name).toBe('think_about_investigation');
        });

        it('should have meaningful description', () => {
            expect(tool.description).toContain('investigation');
            expect(tool.description).toContain('progress');
        });
    });

    describe('Schema Validation', () => {
        it('should accept valid input with all required fields', () => {
            const parsed = tool.schema.safeParse({
                assigned_task: 'Investigate auth token handling',
                questions_answered: ['How are tokens validated?'],
                questions_remaining: ['What happens on token expiry?'],
                evidence_gathered: ['Token validation in auth.ts:45'],
                estimated_iterations_used: 3,
                decision: 'continue_investigating',
            });
            expect(parsed.success).toBe(true);
        });

        it('should accept empty arrays for questions and evidence', () => {
            const parsed = tool.schema.safeParse({
                assigned_task: 'Initial investigation',
                questions_answered: [],
                questions_remaining: [],
                evidence_gathered: [],
                estimated_iterations_used: 0,
                decision: 'investigation_complete',
            });
            expect(parsed.success).toBe(true);
        });

        it('should reject negative iterations', () => {
            const parsed = tool.schema.safeParse({
                assigned_task: 'Test task',
                questions_answered: [],
                questions_remaining: [],
                evidence_gathered: [],
                estimated_iterations_used: -1,
                decision: 'investigation_complete',
            });
            expect(parsed.success).toBe(false);
        });

        it('should accept all valid decision values', () => {
            const decisions = [
                'continue_investigating',
                'wrap_up_partial',
                'investigation_complete',
            ];
            for (const decision of decisions) {
                const parsed = tool.schema.safeParse({
                    assigned_task: 'Test task',
                    questions_answered: [],
                    questions_remaining: [],
                    evidence_gathered: [],
                    estimated_iterations_used: 0,
                    decision,
                });
                expect(parsed.success).toBe(true);
            }
        });

        it('should reject missing required fields', () => {
            const parsed = tool.schema.safeParse({});
            expect(parsed.success).toBe(false);
        });

        it('should reject unexpected parameters in strict mode', () => {
            const parsed = tool.schema.safeParse({
                assigned_task: 'Test task',
                questions_answered: [],
                questions_remaining: [],
                evidence_gathered: [],
                estimated_iterations_used: 0,
                decision: 'investigation_complete',
                extra_param: 'not allowed',
            });
            expect(parsed.success).toBe(false);
        });
    });

    describe('Execution', () => {
        it('should return guidance reflecting assigned task', async () => {
            const result = await tool.execute({
                assigned_task: 'Analyze security implications of auth changes',
                questions_answered: [],
                questions_remaining: [],
                evidence_gathered: [],
                estimated_iterations_used: 1,
                decision: 'investigation_complete',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Assigned Task');
            expect(result.data).toContain(
                'Analyze security implications of auth changes'
            );
        });

        it('should show progress with answered questions', async () => {
            const result = await tool.execute({
                assigned_task: 'Investigate token handling',
                questions_answered: [
                    'Tokens are validated on each request',
                    'JWT is used for encoding',
                ],
                questions_remaining: ['What about refresh tokens?'],
                evidence_gathered: [],
                estimated_iterations_used: 5,
                decision: 'continue_investigating',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Progress: 2 answered, 1 remaining');
            expect(result.data).toContain('Questions Answered');
            expect(result.data).toContain('✓');
            expect(result.data).toContain(
                'Tokens are validated on each request'
            );
        });

        it('should show remaining questions', async () => {
            const result = await tool.execute({
                assigned_task: 'Investigate error handling',
                questions_answered: [],
                questions_remaining: [
                    'How are 500 errors handled?',
                    'Is there retry logic?',
                ],
                evidence_gathered: [],
                estimated_iterations_used: 2,
                decision: 'continue_investigating',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Questions Remaining');
            expect(result.data).toContain('○');
            expect(result.data).toContain('How are 500 errors handled?');
        });

        it('should show evidence gathered', async () => {
            const result = await tool.execute({
                assigned_task: 'Trace data flow',
                questions_answered: ['Data flows from API to DB'],
                questions_remaining: [],
                evidence_gathered: [
                    'api.ts:45 - validates input',
                    'db.ts:123 - stores data',
                ],
                estimated_iterations_used: 4,
                decision: 'investigation_complete',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Evidence Gathered');
            expect(result.data).toContain('api.ts:45 - validates input');
            expect(result.data).toContain('db.ts:123 - stores data');
        });

        it('should show iterations used', async () => {
            const result = await tool.execute({
                assigned_task: 'Quick check',
                questions_answered: [],
                questions_remaining: [],
                evidence_gathered: [],
                estimated_iterations_used: 7,
                decision: 'investigation_complete',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Iterations Used: ~7');
        });

        it('should provide guidance for continue_investigating decision', async () => {
            const result = await tool.execute({
                assigned_task: 'Deep dive into auth',
                questions_answered: ['Basic flow understood'],
                questions_remaining: ['Edge cases unclear'],
                evidence_gathered: [],
                estimated_iterations_used: 3,
                decision: 'continue_investigating',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Decision: CONTINUE INVESTIGATING');
            expect(result.data).toContain('highest-priority');
        });

        it('should provide guidance for wrap_up_partial decision', async () => {
            const result = await tool.execute({
                assigned_task: 'Comprehensive analysis',
                questions_answered: ['Main flow analyzed'],
                questions_remaining: ['Minor edge cases'],
                evidence_gathered: ['Found issue in auth.ts'],
                estimated_iterations_used: 8,
                decision: 'wrap_up_partial',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Decision: WRAP UP PARTIAL');
            expect(result.data).toContain('partial findings');
        });

        it('should provide guidance for investigation_complete decision', async () => {
            const result = await tool.execute({
                assigned_task: 'Full investigation',
                questions_answered: ['All questions answered'],
                questions_remaining: [],
                evidence_gathered: ['Complete evidence trail'],
                estimated_iterations_used: 6,
                decision: 'investigation_complete',
            });

            expect(result.success).toBe(true);
            expect(result.data).toContain('Decision: INVESTIGATION COMPLETE');
            expect(result.data).toContain('final response');
            expect(result.data).toContain('markdown file links');
        });
    });
});

describe('Think Tools Integration', () => {
    const createValidContextInput = () => ({
        files_examined: ['src/file.ts'],
        key_findings: [],
        remaining_gaps: [],
        decision: 'context_sufficient' as const,
    });

    const createValidTaskInput = () => ({
        analysis_focus: 'Test focus',
        issues_found: [],
        areas_needing_investigation: [],
        positive_observations: [],
        decision: 'ready_to_synthesize' as const,
    });

    const createValidCompletionInput = () => ({
        summary_draft: 'This is a valid summary for the PR review.',
        critical_issues_count: 0,
        high_issues_count: 0,
        files_analyzed: ['src/file.ts'],
        files_in_diff: 1,
        recommendation: 'approve' as const,
        decision: 'ready_to_submit' as const,
    });

    const createValidInvestigationInput = () => ({
        assigned_task: 'Test investigation',
        questions_answered: [],
        questions_remaining: [],
        evidence_gathered: [],
        estimated_iterations_used: 0,
        decision: 'investigation_complete' as const,
    });

    it('should all have consistent Markdown structure', async () => {
        const contextTool = new ThinkAboutContextTool();
        const taskTool = new ThinkAboutTaskTool();
        const completionTool = new ThinkAboutCompletionTool();
        const investigationTool = new ThinkAboutInvestigationTool();

        const results = await Promise.all([
            contextTool.execute(createValidContextInput()),
            taskTool.execute(createValidTaskInput()),
            completionTool.execute(createValidCompletionInput()),
            investigationTool.execute(createValidInvestigationInput()),
        ]);

        for (const result of results) {
            expect(result.success).toBe(true);
            expect(result.data).toContain('##');
            expect(result.data).toContain('###');
            expect(result.data).toContain('Decision');
        }
    });

    it('should all require structured input (no empty schemas)', () => {
        const tools = [
            new ThinkAboutContextTool(),
            new ThinkAboutTaskTool(),
            new ThinkAboutCompletionTool(),
            new ThinkAboutInvestigationTool(),
        ];

        for (const tool of tools) {
            expect(tool.schema.safeParse({}).success).toBe(false);
        }
    });

    it('should all reject unexpected parameters', () => {
        const tools = [
            {
                tool: new ThinkAboutContextTool(),
                validInput: createValidContextInput(),
            },
            {
                tool: new ThinkAboutTaskTool(),
                validInput: createValidTaskInput(),
            },
            {
                tool: new ThinkAboutCompletionTool(),
                validInput: createValidCompletionInput(),
            },
            {
                tool: new ThinkAboutInvestigationTool(),
                validInput: createValidInvestigationInput(),
            },
        ];

        for (const { tool, validInput } of tools) {
            const result = tool.schema.safeParse({
                ...validInput,
                unexpected_field: 'not allowed',
            });
            expect(result.success).toBe(false);
        }
    });

    it('should have unique names', () => {
        const tools = [
            new ThinkAboutContextTool(),
            new ThinkAboutTaskTool(),
            new ThinkAboutCompletionTool(),
            new ThinkAboutInvestigationTool(),
        ];

        const names = tools.map((t) => t.name);
        const uniqueNames = new Set(names);
        expect(uniqueNames.size).toBe(tools.length);
    });

    it('should all have decision field that affects output', async () => {
        const contextTool = new ThinkAboutContextTool();

        const result1 = await contextTool.execute({
            files_examined: ['src/file.ts'],
            key_findings: [],
            remaining_gaps: [],
            decision: 'need_more_context',
        });

        const result2 = await contextTool.execute({
            files_examined: ['src/file.ts'],
            key_findings: [],
            remaining_gaps: [],
            decision: 'context_sufficient',
        });

        expect(result1.data).not.toBe(result2.data);
        expect(result1.data).toContain('NEED MORE CONTEXT');
        expect(result2.data).toContain('CONTEXT SUFFICIENT');
    });
});
