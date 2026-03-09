import { describe, it, expect } from 'vitest';
import { ToolAwareSystemPromptGenerator } from '../prompts/toolAwareSystemPromptGenerator';

describe('ToolAwareSystemPromptGenerator', () => {
    const generator = new ToolAwareSystemPromptGenerator();

    describe('generateSystemPrompt', () => {
        it('should generate a system prompt', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toBeDefined();
            expect(prompt.length).toBeGreaterThan(0);
        });

        it('should include role definition', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('Staff Engineer');
            expect(prompt).toContain('pull request review');
        });
    });

    describe('UX guidelines (AC-2.1.9)', () => {
        it('should include tone section', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('<tone>');
            expect(prompt).toContain('</tone>');
        });

        it('should include supportive colleague guidance', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('helpful colleague');
        });

        it('should include framing guidance for catches vs failures', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('catches');
            expect(prompt).toContain('failures');
        });

        it('should include recommendation to use "Consider..." language', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('Consider...');
        });

        it('should include guidance to explain WHY not just WHAT', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('WHY');
            expect(prompt).toContain('WHAT');
        });
    });

    describe('certainty principle (AC-2.1.10)', () => {
        it('should include certainty guidance', () => {
            const prompt = generator.generateSystemPrompt();
            // New structure uses "Certainty Flagging" header
            expect(prompt).toContain('Certainty');
        });

        it('should distinguish between verified and uncertain findings', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt.toLowerCase()).toContain('verif');
            expect(prompt.toLowerCase()).toContain('uncertain');
        });

        it('should include verification callout format with 🔍 emoji', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('🔍');
            expect(prompt).toContain('Verify');
        });

        it('should recommend using tools to verify before claiming', () => {
            const prompt = generator.generateSystemPrompt();
            // Tool names appear in tool selection guide
            expect(prompt).toContain('find_symbol');
        });
    });

    describe("What's Good section (AC-2.1.9)", () => {
        it('should make positive observations section mandatory', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain("What's Good");
            expect(prompt).toContain('REQUIRED');
        });

        it('should instruct to find at least one positive', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('positive');
        });
    });

    describe('file path format (AC-2.1.9)', () => {
        it('should use markdown link format for file paths', () => {
            const prompt = generator.generateSystemPrompt();
            // Check for markdown link format pattern like [file.ts:15](file.ts:15)
            expect(prompt).toMatch(/\[[\w/.]+\.ts:\d+\]\([\w/.]+\.ts:\d+\)/);
        });

        it('should include formatting guidance for markdown links', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('markdown link');
        });
    });

    describe('output structure', () => {
        it('should include severity guide with emoji indicators', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('🔴');
            expect(prompt).toContain('CRITICAL');
            expect(prompt).toContain('🟠');
            expect(prompt).toContain('HIGH');
            expect(prompt).toContain('🟡');
            expect(prompt).toContain('MEDIUM');
            expect(prompt).toContain('🟢');
            expect(prompt).toContain('LOW');
        });

        it('should include key review sections', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('Summary');
            expect(prompt).toContain('Findings');
            expect(prompt).toContain('Severity Guide');
            expect(prompt).toContain('Test');
            expect(prompt).toContain("What's Good");
        });

        it('should include output format section', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('<output_format>');
            expect(prompt).toContain('</output_format>');
        });

        it('should include tone guidance after output format', () => {
            const prompt = generator.generateSystemPrompt();
            const outputEnd = prompt.indexOf('</output_format>');
            const toneStart = prompt.indexOf('<tone>');
            const toneEnd = prompt.indexOf('</tone>');

            // Tone guidance comes after output format as a sibling section
            expect(toneStart).toBeGreaterThan(outputEnd);
            expect(toneEnd).toBeGreaterThan(toneStart);
        });
    });

    describe('finding quality guidance', () => {
        it('should include finding quality section in PR review prompt', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('<finding_quality>');
            expect(prompt).toContain('</finding_quality>');
        });

        it('should include verification gates for common claim types', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('Verification Gates');
            expect(prompt).toContain('Missing error handling');
            expect(prompt).toContain('Missing test for X');
            expect(prompt).toContain('Design inconsistency');
        });

        it('should require counterexamples for "can fail" findings', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('Counterexample Requirement');
            expect(prompt).toContain('Concrete scenario');
            expect(prompt).toContain('drop the finding');
        });

        it('should include confidence-severity matrix', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('Confidence Levels');
            expect(prompt).toContain('VERIFIED');
            expect(prompt).toContain('SPECULATIVE');
        });

        it('should include false positive anti-pattern examples', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('False Positive Patterns');
            expect(prompt).toContain(
                'outer scope, middleware, or executor already catches'
            );
            expect(prompt).toContain('without searching the test directory');
        });

        it('should include scope boundary rule with revert test', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('Scope: Changed Code Only');
            expect(prompt).toContain('Revert Test');
            expect(prompt).toContain('Would reverting this PR fix');
        });

        it('should include false positive cost statement', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('False Positive Cost');
            expect(prompt).toContain('zero reportable findings');
        });

        it('should include design flaw and feature request verification gates', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('Design flaw / should refactor');
            expect(prompt).toContain('Should add X feature');
            expect(prompt).toContain('Pre-existing issue');
        });

        it('should cap feature suggestions at LOW severity', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('suggestion, not a bug');
        });

        it('should include layered validation awareness', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('Layered Validation Awareness');
            expect(prompt).toContain('Middleware/executor catches errors');
            expect(prompt).toContain('Caller validates before calling');
            expect(prompt).toContain('surrounding layer already provides it');
        });

        it('should include try-catch verification gate', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('Should add try-catch');
            expect(prompt).toContain('redundant error handling');
        });

        it('should require caller trace in counterexample requirement', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('trace ALL callers');
            expect(prompt).toContain('unreachable');
        });

        it('should include expanded false positive patterns for tests and docs', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('Missing test');
            expect(prompt).toContain('trivial pass-through');
            expect(prompt).toContain('Missing integration test');
            expect(prompt).toContain('Should document rationale');
            expect(prompt).toContain('unreachable');
        });

        it('should include integration test complexity gate', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('Missing integration test');
            expect(prompt).toContain('3+ mocked layers');
        });

        it('should include production caller verification gate', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('production callers');
            expect(prompt).toContain('future API surface');
        });

        it('should include role-aware asymmetry in FP patterns', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain(
                'Verify the ROLE before claiming inconsistency'
            );
        });

        it('should include performance quantification in FP patterns', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('quantifying actual n and m');
            expect(prompt).toContain('Premature optimization is not a finding');
        });

        it('should include defense-in-depth boundary clarification', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('trust boundaries');
            expect(prompt).toContain('internal method calls');
        });

        it('should include call-site contract verification gate', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('call-site contract');
            expect(prompt).toContain('Method X lacks guard Y');
        });

        it('should include centralized error handler FP pattern', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('centralized error handler');
            expect(prompt).toContain('ToolExecutor');
        });

        it('should include construction-guaranteed invariant FP pattern', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('Missing filtering/dedup');
            expect(prompt).toContain('guarantees the property by construction');
        });

        it('should include finding quality in recursive root prompt', () => {
            const prompt = generator.generateRecursiveSystemPrompt();
            expect(prompt).toContain('<finding_quality>');
            expect(prompt).toContain('Verification Gates');
        });

        it('should include disproof guidance in self-reflection', () => {
            const prompt = generator.generateSystemPrompt();
            expect(prompt).toContain('disproof');
        });
    });
});
