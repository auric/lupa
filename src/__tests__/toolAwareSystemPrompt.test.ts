import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolAwareSystemPromptGenerator } from '../prompts/toolAwareSystemPromptGenerator';
import { ITool } from '../tools/ITool';
import { z } from 'zod';
import * as vscode from 'vscode';

// Mock tools for testing
class MockFindSymbolTool implements ITool {
    name = 'find_symbol';
    description = 'Find the definition of a code symbol by name';
    schema = z.object({
        symbolName: z.string().describe('The name of the symbol to find'),
        relativePath: z.string().optional().describe('Optional relative path to search within'),
        includeFullBody: z.boolean().default(true).describe('Whether to include the full symbol body')
    });

    getVSCodeTool(): vscode.LanguageModelChatTool {
        return {
            name: this.name,
            description: this.description,
            inputSchema: this.schema as any
        };
    }

    async execute(args: any): Promise<any> {
        return [];
    }
}

class MockSearchPatternTool implements ITool {
    name = 'search_for_pattern';
    description = 'Search for a regex pattern in the codebase';
    schema = z.object({
        pattern: z.string().describe('The regex pattern to search for'),
        include: z.string().optional().describe('Optional glob pattern to filter files'),
        path: z.string().optional().describe('Optional relative path to search within')
    });

    getVSCodeTool(): vscode.LanguageModelChatTool {
        return {
            name: this.name,
            description: this.description,
            inputSchema: this.schema as any
        };
    }

    async execute(args: any): Promise<any> {
        return [];
    }
}

describe('ToolAwareSystemPromptGenerator', () => {
    let generator: ToolAwareSystemPromptGenerator;
    let mockTools: ITool[];

    beforeEach(() => {
        generator = new ToolAwareSystemPromptGenerator();
        mockTools = [
            new MockFindSymbolTool(),
            new MockSearchPatternTool()
        ];
    });

    describe('generateSystemPrompt', () => {
        it('should generate a comprehensive system prompt with no tools', () => {
            const prompt = generator.generateSystemPrompt([]);

            expect(prompt).toContain('Expert Senior Software Engineer');
            expect(prompt).toContain('Security vulnerability identification');
            expect(prompt).toContain('Performance optimization');
            expect(prompt).toContain('Code quality evaluation');
            expect(prompt).not.toContain('Available Code Analysis Tools');
        });

        it('should include tool section when tools are provided', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('Expert Senior Software Engineer');
            expect(prompt).toContain('## Available Code Analysis Tools');
            expect(prompt).toContain('**find_symbol**: Find the definition of a code symbol by name');
            expect(prompt).toContain('**search_for_pattern**: Search for a regex pattern in the codebase');
        });

        it('should include strategic tool usage guidance', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('### Strategic Tool Usage');
            expect(prompt).toContain('**When to use each tool:**');
            expect(prompt).toContain('**find_symbol**: When you encounter unknown functions');
            expect(prompt).toContain('**search_for_pattern**: To find similar code patterns');
            expect(prompt).toContain('**Analysis Strategy:**');
            expect(prompt).toContain('**Proactive Approach**');
        });

        it('should include analysis methodology section', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('## Analysis Methodology');
            expect(prompt).toContain('Think step-by-step');
            expect(prompt).toContain('**Initial Assessment**');
            expect(prompt).toContain('**Context Gathering**');
            expect(prompt).toContain('**Impact Analysis**');
            expect(prompt).toContain('**Critical Thinking Framework:**');
        });

        it('should include response structure guidance', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('## Response Structure');
            expect(prompt).toContain('<thinking>');
            expect(prompt).toContain('<suggestion_security>');
            expect(prompt).toContain('<suggestion_performance>');
            expect(prompt).toContain('<suggestion_maintainability>');
            expect(prompt).toContain('<suggestion_reliability>');
            expect(prompt).toContain('<suggestion_type_safety>');
            expect(prompt).toContain('<example_fix>');
            expect(prompt).toContain('<explanation>');
            expect(prompt).toContain('**Quality Standards:**');
        });

        it('should extract parameter descriptions from tool schemas', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            // Should include parameter information extracted from Zod schemas
            expect(prompt).toContain('symbolName');
            expect(prompt).toContain('pattern');
            expect(prompt).toContain('includeFullBody');
        });

        it('should handle tools with complex schemas', () => {
            const complexTool: ITool = {
                name: 'complex_tool',
                description: 'A tool with complex parameters',
                schema: z.object({
                    requiredParam: z.string().describe('A required parameter'),
                    optionalParam: z.number().optional().describe('An optional parameter'),
                    booleanParam: z.boolean().default(false).describe('A boolean parameter')
                }),
                getVSCodeTool: () => ({ name: 'complex_tool', description: '', parametersSchema: {} as any }),
                execute: async () => []
            };

            const prompt = generator.generateSystemPrompt([complexTool]);

            expect(prompt).toContain('**complex_tool**: A tool with complex parameters');
            expect(prompt).toContain('requiredParam');
            expect(prompt).toContain('optionalParam');
            expect(prompt).toContain('booleanParam');
        });

        it('should maintain consistent structure and formatting', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            // Check that the prompt has proper section ordering
            const roleIndex = prompt.indexOf('Expert Senior Software Engineer');
            const toolsIndex = prompt.indexOf('## Available Code Analysis Tools');
            const methodologyIndex = prompt.indexOf('## Analysis Methodology');
            const responseIndex = prompt.indexOf('## Response Structure');

            expect(roleIndex).toBeLessThan(toolsIndex);
            expect(toolsIndex).toBeLessThan(methodologyIndex);
            expect(methodologyIndex).toBeLessThan(responseIndex);
        });
    });

    describe('schema extraction', () => {
        it('should handle tools with empty or malformed schemas gracefully', () => {
            const badTool: ITool = {
                name: 'bad_tool',
                description: 'A tool with problematic schema',
                schema: null as any,
                getVSCodeTool: () => ({ name: 'bad_tool', description: '', parametersSchema: {} as any }),
                execute: async () => []
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
                    param2: z.number()
                }),
                getVSCodeTool: () => ({ name: 'simple_tool', description: '', parametersSchema: {} as any }),
                execute: async () => []
            };

            const prompt = generator.generateSystemPrompt([simpleTool]);
            expect(prompt).toContain('**simple_tool**: A simple tool');
        });
    });
});