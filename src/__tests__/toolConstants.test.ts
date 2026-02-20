import { describe, it, expect } from 'vitest';
import {
    SubagentLimits,
    SubagentErrors,
    MAIN_ANALYSIS_ONLY_TOOLS,
} from '../models/toolConstants';

describe('toolConstants', () => {
    describe('SubagentLimits.DISALLOWED_TOOLS', () => {
        it('should include all MAIN_ANALYSIS_ONLY_TOOLS to prevent subagent access', () => {
            for (const tool of MAIN_ANALYSIS_ONLY_TOOLS) {
                expect(
                    SubagentLimits.DISALLOWED_TOOLS.includes(tool as any),
                    `${tool} should be in DISALLOWED_TOOLS but was not found`
                ).toBe(true);
            }
        });

        it('should include run_subagent to prevent recursion', () => {
            expect(
                SubagentLimits.DISALLOWED_TOOLS.includes('run_subagent')
            ).toBe(true);
        });

        it('should allow think_about_investigation for subagents', () => {
            expect(
                SubagentLimits.DISALLOWED_TOOLS.includes(
                    'think_about_investigation' as any
                )
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
    });
});
