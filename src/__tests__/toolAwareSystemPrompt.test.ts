import { describe, it, expect, beforeEach } from 'vitest';
import { ToolAwareSystemPromptGenerator } from '../prompts/toolAwareSystemPromptGenerator';
import { ITool } from '../tools/ITool';
import * as z from 'zod';
import * as vscode from 'vscode';

// Mock tools for testing
class MockFindSymbolTool implements ITool {
    name = 'find_symbol';
    description = 'Find code symbol definitions (functions, classes, methods)';
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
    description = 'Search for text patterns across the codebase';
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

            expect(prompt).toContain('Staff Engineer');
            expect(prompt).toContain('Finding subtle bugs');
            expect(prompt).toContain('security vulnerabilities');
            expect(prompt).toContain('actionable feedback');
            expect(prompt).not.toContain('Available Code Analysis Tools');
        });

        it('should include tool section when tools are provided', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('Staff Engineer');
            expect(prompt).toContain('## Available Code Analysis Tools');
            expect(prompt).toContain('**find_symbol**');
            expect(prompt).toContain('**search_for_pattern**');
        });

        it('should include tool selection guide', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('<tool_selection_guide>');
            expect(prompt).toContain('## Tool Selection Guide');
            expect(prompt).toContain('| When You Need To...');
            expect(prompt).toContain('### Tool Usage Principles');
            expect(prompt).toContain('Verify Before Claiming');
            expect(prompt).toContain('### Anti-Patterns to Avoid');
        });

        it('should include subagent delegation guidance', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('<subagent_delegation>');
            expect(prompt).toContain('### MANDATORY Triggers');
            expect(prompt).toContain('File Count ≥ 4');
            expect(prompt).toContain('Security-Sensitive Code');
            expect(prompt).toContain('### Subagent Capabilities');
            expect(prompt).toContain('### Writing Effective Subagent Tasks');
            expect(prompt).toContain('<good_subagent_examples>');
            expect(prompt).toContain('<bad_subagent_examples>');
        });

        it('should include analysis methodology section', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('<analysis_methodology>');
            expect(prompt).toContain('## Analysis Methodology');
            expect(prompt).toContain('Think step-by-step');
            expect(prompt).toContain('Initial Scan');
            expect(prompt).toContain('Context Gathering');
            expect(prompt).toContain('Spawn Subagents Early');
            expect(prompt).toContain('Critical Thinking Framework');
        });

        it('should include output format guidance with Markdown structure', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('<output_format>');
            expect(prompt).toContain('## Output Format');
            expect(prompt).toContain('### 1. Summary');
            expect(prompt).toContain('### 2. Critical Issues');
            expect(prompt).toContain('### 3. Suggestions by Category');
            expect(prompt).toContain('### Severity Guide');
            expect(prompt).toContain('🔴');
            expect(prompt).toContain('🟠');
            expect(prompt).toContain('🟡');
            expect(prompt).toContain('🟢');
        });

        it('should include workflow examples', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

            expect(prompt).toContain('<workflow_example>');
            expect(prompt).toContain('SCENARIO: PR modifies 5 files');
            expect(prompt).toContain('SCENARIO: PR modifies 2 files');
        });

        it('should extract parameter descriptions from tool schemas', () => {
            const prompt = generator.generateSystemPrompt(mockTools);

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
                execute: async () => ({ success: true, data: '' })
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
            const roleIndex = prompt.indexOf('Staff Engineer');
            const toolsIndex = prompt.indexOf('## Available Code Analysis Tools');
            const methodologyIndex = prompt.indexOf('## Analysis Methodology');
            const outputIndex = prompt.indexOf('## Output Format');

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
                getVSCodeTool: () => ({ name: 'bad_tool', description: '', parametersSchema: {} as any }),
                execute: async () => ({ success: true, data: '' })
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
                execute: async () => ({ success: true, data: '' })
            };

            const prompt = generator.generateSystemPrompt([simpleTool]);
            expect(prompt).toContain('**simple_tool**: A simple tool');
        });
    });
});