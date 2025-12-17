import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromptGenerator } from '../models/promptGenerator';
import { ITool } from '../tools/ITool';
import { DiffHunk } from '../types/contextTypes';
import * as z from 'zod';
import * as vscode from 'vscode';

// Mock tool for testing
class MockTool implements ITool {
    name = 'mock_tool';
    description = 'A mock tool for testing';
    schema = z.object({
        param1: z.string().describe('First parameter'),
        param2: z.number().optional().describe('Second parameter')
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

describe('PromptGenerator - Tool Calling Features', () => {
    let promptGenerator: PromptGenerator;
    let mockTools: ITool[];
    let sampleDiff: string;
    let sampleParsedDiff: DiffHunk[];

    beforeEach(() => {
        promptGenerator = new PromptGenerator();
        mockTools = [new MockTool()];

        sampleDiff = `diff --git a/src/example.ts b/src/example.ts
index 1234567..abcdefg 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,5 +1,7 @@
 function example() {
+    // New comment
     const value = 42;
+    console.log('Debug:', value);
     return value;
 }`;

        sampleParsedDiff = [{
            filePath: 'src/example.ts',
            isNewFile: false,
            isDeletedFile: false,
            originalHeader: 'diff --git a/src/example.ts b/src/example.ts',
            hunks: [{
                oldStart: 1,
                oldLines: 5,
                newStart: 1,
                newLines: 7,
                parsedLines: [
                    { type: 'context', content: ' function example() {', lineNumber: 1 },
                    { type: 'added', content: '    // New comment', lineNumber: 2 },
                    { type: 'context', content: '     const value = 42;', lineNumber: 3 },
                    { type: 'added', content: '    console.log(\'Debug:\', value);', lineNumber: 4 },
                    { type: 'context', content: '     return value;', lineNumber: 5 },
                    { type: 'context', content: ' }', lineNumber: 6 }
                ],
                hunkId: 'src/example.ts:1',
                hunkHeader: '@@ -1,5 +1,7 @@'
            }]
        }];
    });

    describe('generateToolAwareSystemPrompt', () => {
        it('should generate a comprehensive tool-aware system prompt', () => {
            const systemPrompt = promptGenerator.generateToolAwareSystemPrompt(mockTools);

            expect(systemPrompt).toContain('Staff Engineer');
            expect(systemPrompt).toContain('## Available Code Analysis Tools');
            expect(systemPrompt).toContain('**mock_tool**: A mock tool for testing');
            expect(systemPrompt).toContain('## Tool Selection Guide');
            expect(systemPrompt).toContain('## Analysis Methodology');
            expect(systemPrompt).toContain('## Output Format');
        });

        it('should handle empty tools array', () => {
            const systemPrompt = promptGenerator.generateToolAwareSystemPrompt([]);

            expect(systemPrompt).toContain('Staff Engineer');
            expect(systemPrompt).not.toContain('## Available Code Analysis Tools');
        });

        it('should include parameter information from tool schemas', () => {
            const systemPrompt = promptGenerator.generateToolAwareSystemPrompt(mockTools);

            expect(systemPrompt).toContain('param1');
            expect(systemPrompt).toContain('param2');
        });
    });

    describe('generateToolCallingUserPrompt', () => {
        it('should generate a structured tool-calling user prompt', () => {
            const userPrompt = promptGenerator.generateToolCallingUserPrompt(sampleParsedDiff);

            expect(userPrompt).toContain('<files_to_review>');
            expect(userPrompt).toContain('<file>');
            expect(userPrompt).toContain('<path>src/example.ts</path>');
            expect(userPrompt).toContain('<changes>');
            expect(userPrompt).toContain('<tool_usage_examples>');
            expect(userPrompt).toContain('<instructions>');
        });

        it('should include file content section', () => {
            const userPrompt = promptGenerator.generateToolCallingUserPrompt(sampleParsedDiff);

            expect(userPrompt).toContain('function example()');
            expect(userPrompt).toContain('// New comment');
            expect(userPrompt).toContain('console.log');
        });

        it('should include tool usage examples', () => {
            const userPrompt = promptGenerator.generateToolCallingUserPrompt(sampleParsedDiff);

            expect(userPrompt).toContain('<tool_usage_examples>');
            expect(userPrompt).toContain('<scenario>Encountering unknown function in diff</scenario>');
            expect(userPrompt).toContain('<scenario>New file in diff with unclear context</scenario>');
            expect(userPrompt).toContain('<scenario>Refactoring with potential breaking changes</scenario>');
            expect(userPrompt).toContain('find_symbol');
            expect(userPrompt).toContain('find_usages');
            expect(userPrompt).toContain('search_for_pattern');
        });

        it('should include comprehensive tool-calling instructions', () => {
            const userPrompt = promptGenerator.generateToolCallingUserPrompt(sampleParsedDiff);

            expect(userPrompt).toContain('## Tool-Powered Analysis Approach');
            expect(userPrompt).toContain('**Step 1: Initial Context Gathering**');
            expect(userPrompt).toContain('**Step 2: Deep Dive Investigation**');
            expect(userPrompt).toContain('**Step 3: Comprehensive Analysis**');
            expect(userPrompt).toContain('**Tool Usage Strategy:**');
            expect(userPrompt).toContain('**Analysis Quality Requirements:**');
        });

        it('should structure content according to long context optimization', () => {
            const userPrompt = promptGenerator.generateToolCallingUserPrompt(sampleParsedDiff);

            // File content should come first for long context optimization
            const fileContentIndex = userPrompt.indexOf('<files_to_review>');
            const examplesIndex = userPrompt.indexOf('<tool_usage_examples>');
            const instructionsIndex = userPrompt.indexOf('<instructions>');

            expect(fileContentIndex).toBeLessThan(examplesIndex);
            expect(examplesIndex).toBeLessThan(instructionsIndex);
        });

        it('should include thinking tag in response structure', () => {
            const userPrompt = promptGenerator.generateToolCallingUserPrompt(sampleParsedDiff);

            expect(userPrompt).toContain('<thinking>');
            expect(userPrompt).toContain('Document your tool usage and reasoning process');
        });

        it('should include all required analysis categories', () => {
            const userPrompt = promptGenerator.generateToolCallingUserPrompt(sampleParsedDiff);

            expect(userPrompt).toContain('<suggestion_security>');
            expect(userPrompt).toContain('<suggestion_performance>');
            expect(userPrompt).toContain('<suggestion_maintainability>');
            expect(userPrompt).toContain('<suggestion_reliability>');
            expect(userPrompt).toContain('<suggestion_type_safety>');
            expect(userPrompt).toContain('<example_fix>');
            expect(userPrompt).toContain('<explanation>');
        });
    });

    describe('tool information deprecation', () => {
        it('should still support legacy getToolInformation method', () => {
            const toolInfo = promptGenerator.getToolInformation();

            expect(toolInfo).toContain('Available tools:');
            expect(toolInfo).toContain('find_symbol');
            expect(toolInfo).toContain('Use these tools proactively');
        });

        it('should indicate deprecation in the method', () => {
            // This test verifies the method exists for backward compatibility
            expect(typeof promptGenerator.getToolInformation).toBe('function');
        });
    });

    describe('integration with existing methods', () => {
        it('should maintain compatibility with existing generateUserPrompt', () => {
            const contextString = 'Some context information';
            const legacyPrompt = promptGenerator.generateUserPrompt(
                sampleParsedDiff,
                contextString,
                true
            );

            expect(legacyPrompt).toContain('<context>');
            expect(legacyPrompt).toContain(contextString);
            expect(legacyPrompt).toContain('<examples>');
            expect(legacyPrompt).toContain('<files_to_review>');
            expect(legacyPrompt).toContain('<instructions>');
        });

        it('should maintain compatibility with getSystemPrompt', () => {
            const systemPrompt = promptGenerator.getSystemPrompt();

            expect(systemPrompt).toContain('Expert Senior Software Engineer');
            expect(systemPrompt).toContain('Security vulnerability identification');
        });

        it('should maintain compatibility with getResponsePrefill', () => {
            const prefill = promptGenerator.getResponsePrefill();

            expect(prefill).toContain('analyze this pull request comprehensively');
            expect(prefill).toContain('## Comprehensive Code Review Analysis');
        });
    });

    describe('error handling', () => {
        it('should handle empty diff gracefully', () => {
            expect(() => {
                promptGenerator.generateToolCallingUserPrompt([]);
            }).not.toThrow();
        });

        it('should handle malformed parsed diff gracefully', () => {
            const malformedDiff: DiffHunk[] = [{
                filePath: 'test.ts',
                isNewFile: false,
                isDeletedFile: false,
                originalHeader: 'diff --git a/test.ts b/test.ts',
                hunks: []
            }];

            expect(() => {
                promptGenerator.generateToolCallingUserPrompt(malformedDiff);
            }).not.toThrow();
        });
    });
});