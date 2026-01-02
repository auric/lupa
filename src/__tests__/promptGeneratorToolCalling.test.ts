import { describe, it, expect, beforeEach } from 'vitest';
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
        param2: z.number().optional().describe('Second parameter'),
    });

    getVSCodeTool(): vscode.LanguageModelChatTool {
        return {
            name: this.name,
            description: this.description,
            inputSchema: this.schema as any,
        };
    }

    async execute(_args: any): Promise<any> {
        return [];
    }
}

describe('PromptGenerator - Tool Calling Features', () => {
    let promptGenerator: PromptGenerator;
    let mockTools: ITool[];
    let sampleParsedDiff: DiffHunk[];

    beforeEach(() => {
        promptGenerator = new PromptGenerator();
        mockTools = [new MockTool()];

        sampleParsedDiff = [
            {
                filePath: 'src/example.ts',
                isNewFile: false,
                isDeletedFile: false,
                originalHeader: 'diff --git a/src/example.ts b/src/example.ts',
                hunks: [
                    {
                        oldStart: 1,
                        oldLines: 5,
                        newStart: 1,
                        newLines: 7,
                        parsedLines: [
                            {
                                type: 'context',
                                content: ' function example() {',
                                lineNumber: 1,
                            },
                            {
                                type: 'added',
                                content: '    // New comment',
                                lineNumber: 2,
                            },
                            {
                                type: 'context',
                                content: '     const value = 42;',
                                lineNumber: 3,
                            },
                            {
                                type: 'added',
                                content: "    console.log('Debug:', value);",
                                lineNumber: 4,
                            },
                            {
                                type: 'context',
                                content: '     return value;',
                                lineNumber: 5,
                            },
                            { type: 'context', content: ' }', lineNumber: 6 },
                        ],
                        hunkId: 'src/example.ts:1',
                        hunkHeader: '@@ -1,5 +1,7 @@',
                    },
                ],
            },
        ];
    });

    describe('generateToolAwareSystemPrompt', () => {
        it('should generate a comprehensive tool-aware system prompt', () => {
            const systemPrompt =
                promptGenerator.generateToolAwareSystemPrompt(mockTools);

            expect(systemPrompt).toContain('Staff Engineer');
            expect(systemPrompt).toContain('## Available Tools');
            expect(systemPrompt).toContain(
                '**mock_tool**: A mock tool for testing'
            );
            expect(systemPrompt).toContain('Tool Selection');
            expect(systemPrompt).toContain('Analysis');
            expect(systemPrompt).toContain('output_format');
        });

        it('should handle empty tools array', () => {
            const systemPrompt = promptGenerator.generateToolAwareSystemPrompt(
                []
            );

            expect(systemPrompt).toContain('Staff Engineer');
            expect(systemPrompt).not.toContain('## Available Tools');
        });

        it('should include parameter information from tool schemas', () => {
            const systemPrompt =
                promptGenerator.generateToolAwareSystemPrompt(mockTools);

            expect(systemPrompt).toContain('param1');
            expect(systemPrompt).toContain('param2');
        });
    });

    describe('generateToolCallingUserPrompt', () => {
        it('should generate a structured tool-calling user prompt', () => {
            const userPrompt =
                promptGenerator.generateToolCallingUserPrompt(sampleParsedDiff);

            expect(userPrompt).toContain('<files_to_review>');
            expect(userPrompt).toContain('<file>');
            expect(userPrompt).toContain('<path>src/example.ts</path>');
            expect(userPrompt).toContain('<changes>');
            expect(userPrompt).toContain('<analysis_task>');
        });

        it('should include file content section', () => {
            const userPrompt =
                promptGenerator.generateToolCallingUserPrompt(sampleParsedDiff);

            expect(userPrompt).toContain('function example()');
            expect(userPrompt).toContain('// New comment');
            expect(userPrompt).toContain('console.log');
        });

        it('should include workflow reminder', () => {
            const userPrompt =
                promptGenerator.generateToolCallingUserPrompt(sampleParsedDiff);

            expect(userPrompt).toContain('Workflow Reminder');
            expect(userPrompt).toContain('update_plan');
        });

        it('should structure content with files first then task', () => {
            const userPrompt =
                promptGenerator.generateToolCallingUserPrompt(sampleParsedDiff);

            const fileContentIndex = userPrompt.indexOf('<files_to_review>');
            const taskIndex = userPrompt.indexOf('<analysis_task>');

            expect(fileContentIndex).toBeLessThan(taskIndex);
        });

        it('should mention subagent spawning for large PRs', () => {
            // Create a diff with 4+ files
            const largeDiff: DiffHunk[] = Array(5)
                .fill(null)
                .map((_, i) => ({
                    filePath: `src/file${i}.ts`,
                    isNewFile: false,
                    isDeletedFile: false,
                    originalHeader: `diff --git a/src/file${i}.ts b/src/file${i}.ts`,
                    hunks: [],
                }));

            const userPrompt =
                promptGenerator.generateToolCallingUserPrompt(largeDiff);

            expect(userPrompt).toContain('subagent');
            expect(userPrompt).toContain('5 files');
        });
    });

    describe('user focus instructions', () => {
        it('should include user focus section when instructions provided', () => {
            const userPrompt = promptGenerator.generateToolCallingUserPrompt(
                sampleParsedDiff,
                'focus on security vulnerabilities'
            );

            expect(userPrompt).toContain('<user_focus>');
            expect(userPrompt).toContain('focus on security vulnerabilities');
            expect(userPrompt).toContain(
                'prioritize findings related to this request'
            );
        });

        it('should not include user focus section when no instructions', () => {
            const userPrompt =
                promptGenerator.generateToolCallingUserPrompt(sampleParsedDiff);

            expect(userPrompt).not.toContain('<user_focus>');
        });

        it('should not include user focus section when instructions are empty', () => {
            const userPrompt = promptGenerator.generateToolCallingUserPrompt(
                sampleParsedDiff,
                ''
            );

            expect(userPrompt).not.toContain('<user_focus>');
        });

        it('should not include user focus section when instructions are whitespace', () => {
            const userPrompt = promptGenerator.generateToolCallingUserPrompt(
                sampleParsedDiff,
                '   '
            );

            expect(userPrompt).not.toContain('<user_focus>');
        });

        it('should place user focus section before analysis task', () => {
            const userPrompt = promptGenerator.generateToolCallingUserPrompt(
                sampleParsedDiff,
                'check for race conditions'
            );

            const userFocusIndex = userPrompt.indexOf('<user_focus>');
            const taskIndex = userPrompt.indexOf('<analysis_task>');

            expect(userFocusIndex).toBeLessThan(taskIndex);
        });
    });

    describe('error handling', () => {
        it('should handle empty diff gracefully', () => {
            expect(() => {
                promptGenerator.generateToolCallingUserPrompt([]);
            }).not.toThrow();
        });

        it('should handle malformed parsed diff gracefully', () => {
            const malformedDiff: DiffHunk[] = [
                {
                    filePath: 'test.ts',
                    isNewFile: false,
                    isDeletedFile: false,
                    originalHeader: 'diff --git a/test.ts b/test.ts',
                    hunks: [],
                },
            ];

            expect(() => {
                promptGenerator.generateToolCallingUserPrompt(malformedDiff);
            }).not.toThrow();
        });
    });
});
