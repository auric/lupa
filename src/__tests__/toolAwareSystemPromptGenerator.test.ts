import { describe, it, expect } from 'vitest';
import { ToolAwareSystemPromptGenerator } from '../prompts/toolAwareSystemPromptGenerator';
import { DEFAULT_PROFILE } from '../models/modelCalibration';

describe('ToolAwareSystemPromptGenerator', () => {
    const generator = new ToolAwareSystemPromptGenerator();

    describe('generateSystemPrompt', () => {
        it('should generate a system prompt', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toBeDefined();
            expect(prompt.length).toBeGreaterThan(0);
        });

        it('should include role definition', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('Staff Engineer');
            expect(prompt).toContain('pull request review');
        });
    });

    describe('UX guidelines (AC-2.1.9)', () => {
        it('should include tone section', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('<tone>');
            expect(prompt).toContain('</tone>');
        });

        it('should include supportive colleague guidance', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('helpful colleague');
        });

        it('should include framing guidance for catches vs failures', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('catches');
            expect(prompt).toContain('failures');
        });

        it('should include recommendation to use "Consider..." language', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('Consider...');
        });

        it('should include guidance to explain WHY not just WHAT', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('WHY');
            expect(prompt).toContain('WHAT');
        });
    });

    describe('certainty principle (AC-2.1.10)', () => {
        it('should include certainty guidance', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            // New structure uses "Certainty Flagging" header
            expect(prompt).toContain('Certainty');
        });

        it('should distinguish between verified and uncertain findings', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt.toLowerCase()).toContain('verif');
            expect(prompt.toLowerCase()).toContain('uncertain');
        });

        it('should include verification callout format with 🔍 emoji', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('🔍');
            expect(prompt).toContain('Verify');
        });

        it('should recommend using tools to verify before claiming', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            // Tool names appear in tool selection guide
            expect(prompt).toContain('find_symbol');
        });
    });

    describe("What's Good section (AC-2.1.9)", () => {
        it('should make positive observations section mandatory', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain("What's Good");
            expect(prompt).toContain('REQUIRED');
        });

        it('should instruct to find at least one positive', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('positive');
        });
    });

    describe('file path format (AC-2.1.9)', () => {
        it('should use markdown link format for file paths', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            // Check for markdown link format pattern like [file.ts:15](file.ts:15)
            expect(prompt).toMatch(/\[[\w/.]+\.ts:\d+\]\([\w/.]+\.ts:\d+\)/);
        });

        it('should include formatting guidance for markdown links', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('markdown link');
        });
    });

    describe('output structure', () => {
        it('should include severity guide with emoji indicators', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
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
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('Summary');
            expect(prompt).toContain('Findings');
            expect(prompt).toContain('Severity Guide');
            expect(prompt).toContain('Test');
            expect(prompt).toContain("What's Good");
        });

        it('should include output format section', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('<output_format>');
            expect(prompt).toContain('</output_format>');
        });

        it('should include tone guidance after output format', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
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
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('<finding_quality>');
            expect(prompt).toContain('</finding_quality>');
        });

        it('should include verification gates for common claim types', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('Verification Gates');
            expect(prompt).toContain('Missing error handling');
            expect(prompt).toContain('Missing test for X');
            expect(prompt).toContain('Design inconsistency');
        });

        it('should require counterexamples for "can fail" findings', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('Counterexample Requirement');
            expect(prompt).toContain('Concrete scenario');
            expect(prompt).toContain('drop the finding');
        });

        it('should include confidence-severity matrix', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('Confidence Levels');
            expect(prompt).toContain('VERIFIED');
            expect(prompt).toContain('SPECULATIVE');
        });

        it('should include false positive anti-pattern examples', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('False Positive Patterns');
            expect(prompt).toContain(
                'outer scope, middleware, or executor already catches'
            );
            expect(prompt).toContain('without searching the test directory');
        });

        it('should include scope boundary rule with revert test', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('Scope: Changed Code Only');
            expect(prompt).toContain('Revert Test');
            expect(prompt).toContain('Would reverting this PR fix');
        });

        it('should include precision over recall statement', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('Precision > Recall');
            expect(prompt).toContain('zero reportable findings');
        });

        it('should include design inconsistency and feature request verification gates', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('Design inconsistency');
            expect(prompt).toContain('Should add X feature');
            expect(prompt).toContain('Pre-existing code quality issues');
        });

        it('should cap feature suggestions at LOW severity', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('suggestion, not a bug');
        });

        it('should include layered validation awareness', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('Should validate X');
            expect(prompt).toContain(
                'outer scope already catches and handles the error'
            );
            expect(prompt).toContain('caller or middleware already validates');
            expect(prompt).toContain('surrounding layer already provides it');
        });

        it('should include try-catch verification gate', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('Should add try-catch');
            expect(prompt).toContain('outer scope already catches');
        });

        it('should require caller trace in counterexample requirement', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('trace ALL callers');
            expect(prompt).toContain('unreachable');
        });

        it('should include false positive patterns for tests and docs', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('Missing test');
            expect(prompt).toContain('No tests for X');
            expect(prompt).toContain(
                'Documentation that contradicts the implementation'
            );
            expect(prompt).toContain('IS a valid finding');
            expect(prompt).toContain('unreachable');
        });

        it('should include every-finding-must-have requirements', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('Every Finding MUST Have');
            expect(prompt).toContain(
                'Specific tool output showing the problem'
            );
        });

        it('should include concrete scenario requirements in FP guidance', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain(
                'concrete failing scenario with actual values'
            );
            expect(prompt).toContain("Proof it's caused by THIS PR");
        });

        it('should include design intent blindness in FP patterns', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('Design Intent Blindness');
        });

        it('should include intended-scope awareness in FP patterns', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('DESIGNED to only handle X');
            expect(prompt).toContain('intended scope');
        });

        it('should include runtime-aware FP patterns', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain(
                'synchronous operations in single-threaded runtimes'
            );
            expect(prompt).toContain('type system already guarantees');
        });

        it('should include design intent checking guidance', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain(
                'checking for comments or docs explaining why'
            );
            expect(prompt).toContain('Fabricating examples');
        });

        it('should include centralized error handler FP pattern', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('centralized error handler');
            expect(prompt).toContain('ToolExecutor');
        });

        it('should include internal-state constraint FP pattern', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain(
                'internal state already constrained by producers'
            );
            expect(prompt).toContain('ALL callers validate before calling');
        });

        it('should include finding quality in recursive root prompt', () => {
            const prompt =
                generator.generateRecursiveSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('<finding_quality>');
            expect(prompt).toContain('Verification Gates');
        });

        it('should include disproof guidance in self-reflection', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('disproof');
        });
    });
});
