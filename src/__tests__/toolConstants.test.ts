import { describe, it, expect } from 'vitest';
import {
    SubagentLimits,
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
});
