import { describe, it, expect } from 'vitest';
import { ToolAwareSystemPromptGenerator } from '../prompts/toolAwareSystemPromptGenerator';

describe('ToolAwareSystemPromptGenerator', () => {
    const generator = new ToolAwareSystemPromptGenerator();

    describe('generateSystemPrompt', () => {
        it('should generate a system prompt', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toBeDefined();
            expect(prompt.length).toBeGreaterThan(0);
        });

        it('should include role definition', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('Staff Engineer');
            expect(prompt).toContain('pull request review');
        });
    });

    describe('UX guidelines (AC-2.1.9)', () => {
        it('should include tone section', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('<tone>');
            expect(prompt).toContain('</tone>');
        });

        it('should include supportive colleague guidance', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('helpful colleague');
        });

        it('should include framing guidance for catches vs failures', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('catches');
            expect(prompt).toContain('failures');
        });

        it('should include recommendation to use "Consider..." language', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('Consider...');
        });

        it('should include guidance to explain WHY not just WHAT', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('WHY');
            expect(prompt).toContain('WHAT');
        });
    });

    describe('certainty principle (AC-2.1.10)', () => {
        it('should include certainty guidance', () => {
            const prompt = generator.generateSystemPrompt([]);
            // New structure uses "Certainty Flagging" header
            expect(prompt).toContain('Certainty');
        });

        it('should distinguish between verified and uncertain findings', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt.toLowerCase()).toContain('verif');
            expect(prompt.toLowerCase()).toContain('uncertain');
        });

        it('should include verification callout format with 🔍 emoji', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('🔍');
            expect(prompt).toContain('Verify');
        });

        it('should recommend using tools to verify before claiming', () => {
            const prompt = generator.generateSystemPrompt([]);
            // Tool names appear in tool selection guide
            expect(prompt).toContain('find_symbol');
        });
    });

    describe("What's Good section (AC-2.1.9)", () => {
        it('should make positive observations section mandatory', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain("What's Good");
            expect(prompt).toContain('REQUIRED');
        });

        it('should instruct to find at least one positive', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('positive');
        });
    });

    describe('file path format (AC-2.1.9)', () => {
        it('should use markdown link format for file paths', () => {
            const prompt = generator.generateSystemPrompt([]);
            // Check for markdown link format pattern like [file.ts:15](file.ts:15)
            expect(prompt).toMatch(/\[[\w/.]+\.ts:\d+\]\([\w/.]+\.ts:\d+\)/);
        });

        it('should include formatting guidance for markdown links', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('markdown link');
        });
    });

    describe('output structure', () => {
        it('should include severity guide with emoji indicators', () => {
            const prompt = generator.generateSystemPrompt([]);
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
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('Summary');
            expect(prompt).toContain('Critical Issues');
            expect(prompt).toContain('Suggestions');
            expect(prompt).toContain('Test');
            expect(prompt).toContain("What's Good");
        });

        it('should include output format section', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('<output_format>');
            expect(prompt).toContain('</output_format>');
        });

        it('should include tone guidance after output format', () => {
            const prompt = generator.generateSystemPrompt([]);
            const outputEnd = prompt.indexOf('</output_format>');
            const toneStart = prompt.indexOf('<tone>');
            const toneEnd = prompt.indexOf('</tone>');

            // Tone guidance comes after output format as a sibling section
            expect(toneStart).toBeGreaterThan(outputEnd);
            expect(toneEnd).toBeGreaterThan(toneStart);
        });
    });
});
