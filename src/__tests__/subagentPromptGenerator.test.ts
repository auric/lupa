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
    execute: async () => ({ success: true, data: '' })
});

describe('SubagentPromptGenerator', () => {
    let generator: SubagentPromptGenerator;

    beforeEach(() => {
        generator = new SubagentPromptGenerator();
    });

    describe('generateSystemPrompt', () => {
        it('should include the task in the prompt', () => {
            const task: SubagentTask = {
                task: 'Investigate the authentication flow in src/auth/'
            };

            const prompt = generator.generateSystemPrompt(task, [], 10);

            expect(prompt).toContain('Investigate the authentication flow in src/auth/');
        });

        it('should include context when provided', () => {
            const task: SubagentTask = {
                task: 'Check for security issues',
                context: 'PR adds new JWT validation in auth.ts'
            };

            const prompt = generator.generateSystemPrompt(task, [], 10);

            expect(prompt).toContain('PR adds new JWT validation in auth.ts');
            expect(prompt).toContain('Context from Parent Analysis');
        });

        it('should not include context section when not provided', () => {
            const task: SubagentTask = {
                task: 'Check for security issues'
            };

            const prompt = generator.generateSystemPrompt(task, [], 10);

            // The context section header should not appear when no context is provided
            expect(prompt).not.toContain('Context from Parent Analysis');
        });

        it('should list available tools', () => {
            const tools = [
                createMockTool('find_symbol', 'Finds symbols in code'),
                createMockTool('read_file', 'Reads file contents')
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

        it('should include clear results instructions (not XML tags)', () => {
            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, [], 10);

            // New simplified format - no XML tags
            expect(prompt).toContain('Return Clear Results');
            expect(prompt).toContain('What you found');
            expect(prompt).toContain('Why it matters');
        });

        it('should include the maxIterations value in budget message', () => {
            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, [], 15);

            expect(prompt).toContain('15 iterations');
        });

        it('should include investigation instructions', () => {
            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, [], 10);

            expect(prompt).toContain('Investigate Systematically');
            expect(prompt).toContain('Be Proactive');
            expect(prompt).toContain('Be Efficient');
        });
    });
});
