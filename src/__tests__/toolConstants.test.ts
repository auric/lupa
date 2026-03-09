import { describe, it, expect } from 'vitest';
import {
    SubagentLimits,
    SubagentErrors,
    MAIN_ANALYSIS_ONLY_TOOLS,
    RECURSIVE_CHILD_DISALLOWED_TOOLS,
    DIFF_TOOLS,
    INVESTIGATION_TOOLS,
} from '../models/toolConstants';
import { TokenConstants } from '../models/tokenConstants';

describe('toolConstants', () => {
    describe('SubagentLimits.DISALLOWED_TOOLS', () => {
        // get_file_diff is analysis-only but intentionally
        // ALLOWED for subagents so they can access diff on demand (RLM approach).
        const SUBAGENT_ALLOWED_ANALYSIS_TOOLS = ['get_file_diff'];

        it('should include non-diff MAIN_ANALYSIS_ONLY_TOOLS to prevent subagent access', () => {
            for (const tool of MAIN_ANALYSIS_ONLY_TOOLS) {
                if (SUBAGENT_ALLOWED_ANALYSIS_TOOLS.includes(tool)) {
                    continue;
                }
                expect(
                    SubagentLimits.DISALLOWED_TOOLS.includes(tool as any),
                    `${tool} should be in DISALLOWED_TOOLS but was not found`
                ).toBe(true);
            }
        });

        it('should allow diff tools for subagents (RLM approach)', () => {
            for (const tool of SUBAGENT_ALLOWED_ANALYSIS_TOOLS) {
                expect(
                    SubagentLimits.DISALLOWED_TOOLS.includes(tool as any),
                    `${tool} should NOT be in DISALLOWED_TOOLS`
                ).toBe(false);
            }
        });

        it('should include run_subagent to prevent recursion', () => {
            expect(
                SubagentLimits.DISALLOWED_TOOLS.includes('run_subagent')
            ).toBe(true);
        });

        it('should allow think tool for subagents', () => {
            expect(
                SubagentLimits.DISALLOWED_TOOLS.includes('think' as any)
            ).toBe(false);
        });
    });

    describe('SubagentErrors', () => {
        it('should produce maxIterations message with tool call count and limit', () => {
            const message = SubagentErrors.maxIterations(42, 100);
            expect(message).toContain('maximum iterations');
            expect(message).toContain('100');
            expect(message).toContain('42');
            expect(message).toContain('incomplete');
        });

        it('should produce timeout message with duration', () => {
            const message = SubagentErrors.timeout(60000);
            expect(message).toContain('60');
            expect(message).toContain('timed out');
        });

        it('should produce maxExceeded message with limit', () => {
            const message = SubagentErrors.maxExceeded(5);
            expect(message).toContain('5');
            expect(message).toContain('Maximum subagents');
        });

        it('should produce taskTooShort message with minimum length', () => {
            const message = SubagentErrors.taskTooShort(50);
            expect(message).toContain('50');
            expect(message).toContain('too brief');
        });

        it('should produce failed message with error details', () => {
            const message = SubagentErrors.failed(
                'LLM returned empty response'
            );
            expect(message).toContain('Subagent failed');
            expect(message).toContain('LLM returned empty response');
        });
    });

    describe('DRY tool list composition', () => {
        it('should derive RECURSIVE_CHILD_DISALLOWED_TOOLS as subset of DISALLOWED_TOOLS', () => {
            // Every recursive-child disallowed tool should also be disallowed for flat subagents
            for (const tool of RECURSIVE_CHILD_DISALLOWED_TOOLS) {
                expect(
                    SubagentLimits.DISALLOWED_TOOLS.includes(tool as any),
                    `${tool} is in RECURSIVE_CHILD but not in flat DISALLOWED_TOOLS`
                ).toBe(true);
            }
        });

        it('should allow run_subagent for recursive children but not flat subagents', () => {
            expect(
                SubagentLimits.DISALLOWED_TOOLS.includes('run_subagent')
            ).toBe(true);
            expect(
                RECURSIVE_CHILD_DISALLOWED_TOOLS.includes('run_subagent' as any)
            ).toBe(false);
        });

        it('should include DIFF_TOOLS in MAIN_ANALYSIS_ONLY_TOOLS', () => {
            for (const tool of DIFF_TOOLS) {
                expect(
                    MAIN_ANALYSIS_ONLY_TOOLS.includes(tool as any),
                    `${tool} should be in MAIN_ANALYSIS_ONLY_TOOLS`
                ).toBe(true);
            }
        });
    });

    describe('TokenConstants regression guards', () => {
        it('should maintain MAX_TOOL_RESPONSE_CHARS at 60000', () => {
            expect(TokenConstants.MAX_TOOL_RESPONSE_CHARS).toBe(60000);
        });

        it('should maintain MAX_FILE_READ_LINES at 400', () => {
            expect(TokenConstants.MAX_FILE_READ_LINES).toBe(400);
        });
    });

    describe('INVESTIGATION_TOOLS', () => {
        it('should include get_file_diff to prevent root from reading diffs after orientation', () => {
            expect(INVESTIGATION_TOOLS).toContain('get_file_diff');
        });

        it('should include core investigation tools', () => {
            const expected = [
                'read_file',
                'find_symbol',
                'find_usages',
                'search_for_pattern',
                'list_directory',
                'get_symbols_overview',
                'find_files_by_pattern',
            ];
            for (const tool of expected) {
                expect(
                    INVESTIGATION_TOOLS.includes(tool as any),
                    `${tool} should be in INVESTIGATION_TOOLS`
                ).toBe(true);
            }
        });

        it('should NOT include controller tools', () => {
            const controllerTools = [
                'run_subagent',
                'update_plan',
                'submit_review',
                'think_about_completion',
            ];
            for (const tool of controllerTools) {
                expect(
                    INVESTIGATION_TOOLS.includes(tool as any),
                    `${tool} should NOT be in INVESTIGATION_TOOLS`
                ).toBe(false);
            }
        });
    });
});
