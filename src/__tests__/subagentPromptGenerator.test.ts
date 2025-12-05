import { describe, it, expect, beforeEach } from 'vitest';
import { SubagentPromptGenerator } from '../prompts/subagentPromptGenerator';
import type { SubagentTask } from '../types/modelTypes';
import type { ITool } from '../tools/ITool';
import { SubagentLimits } from '../models/toolConstants';

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

            const prompt = generator.generateSystemPrompt(task, []);

            expect(prompt).toContain('Investigate the authentication flow in src/auth/');
        });

        it('should include context when provided', () => {
            const task: SubagentTask = {
                task: 'Check for security issues',
                context: 'PR adds new JWT validation in auth.ts'
            };

            const prompt = generator.generateSystemPrompt(task, []);

            expect(prompt).toContain('PR adds new JWT validation in auth.ts');
            expect(prompt).toContain('Context from Parent Analysis');
        });

        it('should indicate no context when not provided', () => {
            const task: SubagentTask = {
                task: 'Check for security issues'
            };

            const prompt = generator.generateSystemPrompt(task, []);

            expect(prompt).toContain('No additional context provided');
        });

        it('should list available tools', () => {
            const tools = [
                createMockTool('find_symbol', 'Finds symbols in code'),
                createMockTool('read_file', 'Reads file contents')
            ];

            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, tools);

            expect(prompt).toContain('find_symbol');
            expect(prompt).toContain('Finds symbols in code');
            expect(prompt).toContain('read_file');
            expect(prompt).toContain('Reads file contents');
        });

        it('should indicate when no tools are available', () => {
            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, []);

            expect(prompt).toContain('No tools available');
        });

        it('should include the response structure tags', () => {
            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, []);

            expect(prompt).toContain('<findings>');
            expect(prompt).toContain('</findings>');
            expect(prompt).toContain('<summary>');
            expect(prompt).toContain('</summary>');
            expect(prompt).toContain('<answer>');
            expect(prompt).toContain('</answer>');
        });

        it('should include tool call budget from task', () => {
            const task: SubagentTask = {
                task: 'Test task',
                maxToolCalls: 12
            };
            const prompt = generator.generateSystemPrompt(task, []);

            expect(prompt).toContain('12 calls');
        });

        it('should use default tool call budget when not specified', () => {
            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, []);

            expect(prompt).toContain(`${SubagentLimits.DEFAULT_TOOL_CALLS} calls`);
        });

        it('should include investigation instructions', () => {
            const task: SubagentTask = { task: 'Test task' };
            const prompt = generator.generateSystemPrompt(task, []);

            expect(prompt).toContain('Investigate Systematically');
            expect(prompt).toContain('Be Proactive');
            expect(prompt).toContain('Be Efficient');
        });
    });
});
