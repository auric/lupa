import { describe, it, expect, beforeEach } from 'vitest';
import { SubagentPromptGenerator } from '../prompts/subagentPromptGenerator';
import type { SubagentTask } from '../types/modelTypes';
import type { ITool } from '../tools/ITool';

// Mock tool for testing
const createMockTool = (name: string, description: string): ITool => ({
    name,
    description,
    schema: {} as any,
    getVSCodeTool: () => ({ name, description, inputSchema: {} }),
    execute: async () => ({ success: true, data: '' }),
});

describe('SubagentPromptGenerator', () => {
    let generator: SubagentPromptGenerator;

    beforeEach(() => {
        generator = new SubagentPromptGenerator();
    });

    describe('generateSystemPrompt', () => {
        it('should include the task in the prompt', () => {
            const task: SubagentTask = {
                task: 'Investigate the authentication flow in src/auth/',
            };

            const prompt = generator.generateSystemPrompt(task, [], 10);

            expect(prompt).toContain(
                'Investigate the authentication flow in src/auth/'
            );
        });

        it('should include context when provided', () => {
            const task: SubagentTask = {
                task: 'Check for security issues',
                context: 'PR adds new JWT validation in auth.ts',
            };

            const prompt = generator.generateSystemPrompt(task, [], 10);

            expect(prompt).toContain('PR adds new JWT validation in auth.ts');
            expect(prompt).toContain('Context from Parent Agent');
        });

        it('should not include context section when not provided', () => {
            const task: SubagentTask = {
                task: 'Check for security issues',
            };

            const prompt = generator.generateSystemPrompt(task, [], 10);

            expect(prompt).not.toContain('Context from Parent Agent');
        });

        it('should sanitize angle brackets in context to prevent XML tag injection', () => {
            const task: SubagentTask = {
                task: 'Check for security issues',
                context:
                    'Found issue in <script>alert("xss")</script> and src/</path>',
            };

            const prompt = generator.generateSystemPrompt(task, [], 10);

            expect(prompt).not.toContain('<script>');
            expect(prompt).not.toContain('</path>');
            expect(prompt).toContain('alert("xss")');
            expect(prompt).toContain('&lt;script&gt;');
            expect(prompt).toContain('&lt;/path&gt;');
        });

        it('should list available tools', () => {
            const tools = [
                createMockTool('find_symbol', 'Finds symbols in code'),
                createMockTool('read_file', 'Reads file contents'),
            ];

            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, tools, 10);

            expect(prompt).toContain('find_symbol');
            expect(prompt).toContain('Finds symbols in code');
            expect(prompt).toContain('read_file');
            expect(prompt).toContain('Reads file contents');
        });

        it('should indicate when no tools are available', () => {
            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, [], 10);

            expect(prompt).toContain('No tools available');
        });

        it('should include response requirements section', () => {
            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, [], 10);

            expect(prompt).toContain('## Response Requirements');
            expect(prompt).toContain('### Findings');
            expect(prompt).toContain('### Recommendations');
            expect(prompt).toContain('### Summary');
        });

        it('should include the maxIterations value in constraints', () => {
            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, [], 15);

            expect(prompt).toContain('15 tool iterations');
        });

        it('should include investigation approach guidance', () => {
            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, [], 10);

            expect(prompt).toContain('## Investigation Approach');
            expect(prompt).toContain('Gather Evidence');
            expect(prompt).toContain('Trace Dependencies');
        });

        it('should include constraints section without diff tools', () => {
            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, [], 10);

            expect(prompt).toContain('## Constraints');
            expect(prompt).toContain('CANNOT see the PR diff');
            expect(prompt).toContain('CANNOT execute code');
        });

        it('should include diff access guidance when diff tools are available', () => {
            const tools = [
                createMockTool('get_file_diff', 'Get diff for specific files'),
                createMockTool('find_symbol', 'Finds symbols in code'),
            ];
            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, tools, 10);

            expect(prompt).toContain('### Diff Access');
            expect(prompt).toContain('get_file_diff');
            expect(prompt).not.toContain('CANNOT see the PR diff');
        });

        it('should not include diff access guidance without diff tools', () => {
            const tools = [
                createMockTool('find_symbol', 'Finds symbols in code'),
            ];
            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, tools, 10);

            expect(prompt).not.toContain('### Diff Access');
            expect(prompt).toContain('CANNOT see the PR diff');
        });

        describe('without diff tools', () => {
            const noDiffTools = [
                createMockTool('find_symbol', 'Finds symbols in code'),
                createMockTool('find_usages', 'Find usages of a symbol'),
            ];

            it('should not instruct to read diffs when diff tools are absent', () => {
                const task: SubagentTask = { task: 'Test task' };
                const prompt = generator.generateSystemPrompt(
                    task,
                    noDiffTools,
                    10
                );

                expect(prompt).not.toContain('Read the Diff FIRST');
                expect(prompt).not.toContain('get_file_diff');
                expect(prompt).toContain('Review Parent Context');
            });

            it('should instruct to read diffs when diff tools are present', () => {
                const tools = [
                    createMockTool(
                        'get_file_diff',
                        'Get diff for specific files'
                    ),
                    createMockTool('find_symbol', 'Finds symbols in code'),
                ];
                const task: SubagentTask = { task: 'Test task' };
                const prompt = generator.generateSystemPrompt(task, tools, 10);

                expect(prompt).toContain('Read the Diff FIRST');
                expect(prompt).not.toContain('Review Parent Context');
            });
        });

        describe('canRecurse=true', () => {
            const diffTools = [
                createMockTool('get_file_diff', 'Get diff for specific files'),
                createMockTool('find_symbol', 'Finds symbols in code'),
                createMockTool('run_subagent', 'Spawn a sub-agent'),
            ];

            it('should include decomposition strategy when canRecurse with diff tools', () => {
                const task: SubagentTask = { task: 'Test task' };
                const prompt = generator.generateSystemPrompt(
                    task,
                    diffTools,
                    30,
                    true
                );

                expect(prompt).toContain('Decomposition Strategy');
                expect(prompt).toContain(
                    'You MUST Spawn Sub-Agents for 4+ Files'
                );
                expect(prompt).toContain('run_subagent');
            });

            it('should show file-count-based investigation guidance', () => {
                const task: SubagentTask = { task: 'Test task' };
                const prompt = generator.generateSystemPrompt(
                    task,
                    diffTools,
                    30,
                    true
                );

                expect(prompt).toContain('1-3 files');
                expect(prompt).toContain('4+ files');
                expect(prompt).not.toContain('Read the Diff FIRST');
            });

            it('should not include recursion limit message', () => {
                const task: SubagentTask = { task: 'Test task' };
                const prompt = generator.generateSystemPrompt(
                    task,
                    diffTools,
                    30,
                    true
                );

                expect(prompt).not.toContain('maximum recursion depth');
                expect(prompt).not.toContain('cannot spawn');
            });

            it('should show recursion limit when canRecurse=false', () => {
                const task: SubagentTask = { task: 'Test task' };
                const prompt = generator.generateSystemPrompt(
                    task,
                    diffTools,
                    30,
                    false
                );

                expect(prompt).toContain('Recursion Limit');
                expect(prompt).toContain('cannot');
                expect(prompt).not.toContain('Decomposition Strategy');
            });

            it('should include maxIterations in decomposition prompt', () => {
                const task: SubagentTask = { task: 'Test task' };
                const prompt = generator.generateSystemPrompt(
                    task,
                    diffTools,
                    25,
                    true
                );

                expect(prompt).toContain('25 iterations');
            });

            it('should use mandatory language for 4+ file decomposition', () => {
                const task: SubagentTask = { task: 'Test task' };
                const prompt = generator.generateSystemPrompt(
                    task,
                    diffTools,
                    30,
                    true
                );

                expect(prompt).toContain('MANDATORY');
                expect(prompt).toContain('you MUST spawn sub-agents');
                expect(prompt).toContain('This is not optional');
            });

            it('should instruct parallel sub-agent spawning', () => {
                const task: SubagentTask = { task: 'Test task' };
                const prompt = generator.generateSystemPrompt(
                    task,
                    diffTools,
                    30,
                    true
                );

                expect(prompt).toContain('multiple');
                expect(prompt).toContain('run_subagent');
                expect(prompt).toContain('in the same response');
                expect(prompt).toContain('parallel');
            });

            it('should tell 4+ file scope to use MUST spawn in investigation steps', () => {
                const task: SubagentTask = { task: 'Test task' };
                const prompt = generator.generateSystemPrompt(
                    task,
                    diffTools,
                    30,
                    true
                );

                expect(prompt).toContain(
                    '4+ files**: You **MUST** spawn sub-agents'
                );
            });
        });

        describe('canRecurse=true without diff tools', () => {
            const noDiffTools = [
                createMockTool('find_symbol', 'Finds symbols in code'),
                createMockTool('run_subagent', 'Spawn a sub-agent'),
            ];

            it('should not reference get_file_diff in decomposition when diff tools absent', () => {
                const task: SubagentTask = { task: 'Test task' };
                const prompt = generator.generateSystemPrompt(
                    task,
                    noDiffTools,
                    30,
                    true
                );

                expect(prompt).toContain('Decomposition Strategy');
                expect(prompt).not.toContain('get_file_diff');
                expect(prompt).toContain('Review the parent context');
            });

            it('should use context-based investigation steps', () => {
                const task: SubagentTask = { task: 'Test task' };
                const prompt = generator.generateSystemPrompt(
                    task,
                    noDiffTools,
                    30,
                    true
                );

                expect(prompt).toContain('Review Parent Context');
                expect(prompt).not.toContain('Read the Diff FIRST');
            });
        });

        describe('finding quality guidance', () => {
            it('should include finding quality guidance in subagent prompt', () => {
                const task: SubagentTask = { task: 'Test task' };
                const tools = [
                    createMockTool(
                        'get_file_diff',
                        'Get diff for specific files'
                    ),
                    createMockTool(
                        'get_file_diff',
                        'Get diff for specific files'
                    ),
                    createMockTool('find_symbol', 'Finds symbols in code'),
                ];
                const prompt = generator.generateSystemPrompt(task, tools, 30);

                expect(prompt).toContain('Finding Quality');
                expect(prompt).toContain('Verify scope');
                expect(prompt).toContain('Prove it');
                expect(prompt).toContain('Search first');
                expect(prompt).toContain('Consider intent');
            });

            it('should include scope boundary and revert test in subagent prompt', () => {
                const task: SubagentTask = { task: 'Test task' };
                const tools = [
                    createMockTool('find_symbol', 'Finds symbols in code'),
                ];
                const prompt = generator.generateSystemPrompt(task, tools, 30);

                expect(prompt).toContain('Changed code only');
                expect(prompt).toContain('Revert Test');
                expect(prompt).toContain('Suggestions');
                expect(prompt).toContain('When uncertain, omit');
            });

            it('should include layered architecture awareness in subagent prompt', () => {
                const task: SubagentTask = { task: 'Test task' };
                const tools = [
                    createMockTool('find_symbol', 'Finds symbols in code'),
                ];
                const prompt = generator.generateSystemPrompt(task, tools, 30);

                expect(prompt).toContain('Layered architecture');
                expect(prompt).toContain('surrounding layer');
                expect(prompt).toContain('trace ALL callers');
                expect(prompt).toContain('real regression');
            });

            it('should include production caller and performance gates in subagent prompt', () => {
                const task: SubagentTask = { task: 'Test task' };
                const tools = [
                    createMockTool('find_symbol', 'Finds symbols in code'),
                ];
                const prompt = generator.generateSystemPrompt(task, tools, 30);

                expect(prompt).toContain('production callers');
                expect(prompt).toContain('Quantify performance');
            });

            it('should include call-site contract and centralized handler guidance in subagent prompt', () => {
                const task: SubagentTask = { task: 'Test task' };
                const tools = [
                    createMockTool('find_symbol', 'Finds symbols in code'),
                ];
                const prompt = generator.generateSystemPrompt(task, tools, 30);

                expect(prompt).toContain('Call-site contract');
                expect(prompt).toContain('Centralized handlers');
            });
        });
    });
});
