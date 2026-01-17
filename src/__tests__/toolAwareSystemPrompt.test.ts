import { describe, it, expect, beforeEach } from 'vitest';
import { ToolAwareSystemPromptGenerator } from '../prompts/toolAwareSystemPromptGenerator';
import { ITool } from '../tools/ITool';
import * as z from 'zod';
import * as vscode from 'vscode';
import type { ExecutionContext } from '../types/executionContext';

// Mock tools for testing
class MockFindSymbolTool implements ITool {
    name = 'find_symbol';
    description = 'Find code symbol definitions (functions, classes, methods)';
    schema = z.object({
        symbolName: z.string().describe('The name of the symbol to find'),
        relativePath: z
            .string()
            .optional()
            .describe('Optional relative path to search within'),
        includeFullBody: z
            .boolean()
            .default(true)
            .describe('Whether to include the full symbol body'),
    });

    getVSCodeTool(): vscode.LanguageModelChatTool {
        return {
            name: this.name,
            description: this.description,
            inputSchema: this.schema as any,
        };
    }

    async execute(_args: any, _context: ExecutionContext): Promise<any> {
        return [];
    }
}

class MockSearchPatternTool implements ITool {
    name = 'search_for_pattern';
    description = 'Search for text patterns across the codebase';
    schema = z.object({
        pattern: z.string().describe('The regex pattern to search for'),
        include: z
            .string()
            .optional()
            .describe('Optional glob pattern to filter files'),
        path: z
            .string()
            .optional()
            .describe('Optional relative path to search within'),
    });

    getVSCodeTool(): vscode.LanguageModelChatTool {
        return {
            name: this.name,
            description: this.description,
            inputSchema: this.schema as any,
        };
    }

    async execute(_args: any, _context: ExecutionContext): Promise<any> {
        return [];
    }
}

describe('ToolAwareSystemPromptGenerator', () => {
    let generator: ToolAwareSystemPromptGenerator;
    let mockTools: ITool[];

    beforeEach(() => {
        generator = new ToolAwareSystemPromptGenerator();
        mockTools = [new MockFindSymbolTool(), new MockSearchPatternTool()];
    });

    describe('generateSystemPrompt', () => {
        it('should generate a comprehensive system prompt with no tools', () => {
            const prompt = generator.generateSystemPrompt([]);

            expect(prompt).toContain('Staff Engineer');
            expect(prompt).toContain('bugs');
            expect(prompt).toContain('security');
            expect(prompt).toContain('feedback');
            expect(prompt).not.toContain('## Available Tools');
        });

        it('should include tool section when tools are provided', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('Staff Engineer');
            expect(prompt).toContain('## Available Tools');
            expect(prompt).toContain('**find_symbol**');
            expect(prompt).toContain('**search_for_pattern**');
        });

        it('should include tool selection guide', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('<tool_selection_guide>');
            expect(prompt).toContain('Tool Selection');
            expect(prompt).toContain('| Need |');
            expect(prompt).toContain('Principles');
            expect(prompt).toContain('Anti-Patterns');
        });

        it('should include subagent delegation guidance', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('<subagent_guidance>');
            expect(prompt).toContain('Subagent');
            expect(prompt).toContain('4+');
            expect(prompt).toContain('Security');
            expect(prompt).toContain('Task Format');
            expect(prompt).toContain('Valid Questions');
            expect(prompt).toContain('Invalid Questions');
        });

        it('should include analysis methodology section', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('<analysis_methodology>');
            expect(prompt).toContain('Analysis Process');
            expect(prompt).toContain('Create Your Plan');
            expect(prompt).toContain('Gather Context');
            expect(prompt).toContain('update_plan');
            expect(prompt).toContain('Critical Thinking');
        });

        it('should include output format guidance with Markdown structure', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('<output_format>');
            expect(prompt).toContain('Review Format');
            expect(prompt).toContain('Summary');
            expect(prompt).toContain('Critical Issues');
            expect(prompt).toContain('Suggestions');
            expect(prompt).toContain('Severity');
            expect(prompt).toContain('🔴');
            expect(prompt).toContain('🟠');
            expect(prompt).toContain('🟡');
            expect(prompt).toContain('🟢');
        });

        it('should include self-reflection guidance', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('<self_reflection>');
            expect(prompt).toContain('think_about_context');
            expect(prompt).toContain('think_about_task');
            expect(prompt).toContain('think_about_completion');
        });

        it('should extract parameter descriptions from tool schemas', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('symbolName');
            expect(prompt).toContain('pattern');
        });

        it('should handle tools with complex schemas', () => {
            const complexTool: ITool = {
                name: 'complex_tool',
                description: 'A tool with complex parameters',
                schema: z.object({
                    requiredParam: z.string().describe('A required parameter'),
                    optionalParam: z
                        .number()
                        .optional()
                        .describe('An optional parameter'),
                    booleanParam: z
                        .boolean()
                        .default(false)
                        .describe('A boolean parameter'),
                }),
                getVSCodeTool: () => ({
                    name: 'complex_tool',
                    description: '',
                    parametersSchema: {} as any,
                }),
                execute: async () => ({ success: true, data: '' }),
            };

            const prompt = generator.generateSystemPrompt([complexTool]);

            expect(prompt).toContain(
                '**complex_tool**: A tool with complex parameters'
            );
            expect(prompt).toContain('requiredParam');
            expect(prompt).toContain('optionalParam');
            expect(prompt).toContain('booleanParam');
        });

        it('should maintain consistent structure and formatting', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            // Check that the prompt has proper section ordering
            const roleIndex = prompt.indexOf('Staff Engineer');
            const toolsIndex = prompt.indexOf('## Available Tools');
            const methodologyIndex = prompt.indexOf('<analysis_methodology>');
            const outputIndex = prompt.indexOf('<output_format>');

            expect(roleIndex).toBeLessThan(toolsIndex);
            expect(toolsIndex).toBeLessThan(methodologyIndex);
            expect(methodologyIndex).toBeLessThan(outputIndex);
        });
    });

    describe('schema extraction', () => {
        it('should handle tools with empty or malformed schemas gracefully', () => {
            const badTool: ITool = {
                name: 'bad_tool',
                description: 'A tool with problematic schema',
                schema: null as any,
                getVSCodeTool: () => ({
                    name: 'bad_tool',
                    description: '',
                    parametersSchema: {} as any,
                }),
                execute: async () => ({ success: true, data: '' }),
            };

            expect(() => {
                generator.generateSystemPrompt([badTool]);
            }).not.toThrow();
        });

        it('should handle tools with no parameter descriptions', () => {
            const simpleTool: ITool = {
                name: 'simple_tool',
                description: 'A simple tool',
                schema: z.object({
                    param1: z.string(),
                    param2: z.number(),
                }),
                getVSCodeTool: () => ({
                    name: 'simple_tool',
                    description: '',
                    parametersSchema: {} as any,
                }),
                execute: async () => ({ success: true, data: '' }),
            };

            const prompt = generator.generateSystemPrompt([simpleTool]);
            expect(prompt).toContain('**simple_tool**: A simple tool');
        });
    });
});
