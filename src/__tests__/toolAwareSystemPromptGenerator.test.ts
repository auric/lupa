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
        it('should include tone_guidelines section', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('<tone_guidelines>');
            expect(prompt).toContain('</tone_guidelines>');
        });

        it('should include supportive, non-judgmental language guidance', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('supportive, not judgmental');
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
            expect(prompt).toContain('Potential issue:');
        });

        it('should include guidance to explain WHY not just WHAT', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('WHY something matters');
            expect(prompt).toContain('WHAT is wrong');
        });
    });

    describe('certainty principle (AC-2.1.10)', () => {
        it('should include certainty_principle section', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('<certainty_principle>');
            expect(prompt).toContain('</certainty_principle>');
        });

        it('should distinguish between VERIFIED and UNCERTAIN findings', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('VERIFIED findings');
            expect(prompt).toContain('UNCERTAIN findings');
        });

        it('should include verification callout format with 🔍 emoji', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('🔍 **Verify:**');
        });

        it('should advise against confidence levels on every finding', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('do NOT add confidence levels to every finding');
        });

        it('should recommend verifying with tools before claiming', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('find_symbol');
            expect(prompt).toContain('find_usages');
        });
    });

    describe("What's Good section (AC-2.1.9)", () => {
        it('should make positive observations section mandatory', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain("What's Good (REQUIRED - never skip this section)");
        });

        it('should instruct to always find at least one positive', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('Always find at least one positive observation');
        });
    });

    describe('file path format (AC-2.1.9)', () => {
        it('should use markdown link format for file paths', () => {
            const prompt = generator.generateSystemPrompt([]);
            // Check for markdown link format pattern like [file.ts:15](file.ts:15)
            expect(prompt).toMatch(/\[[a-zA-Z/]+\.ts:\d+\]\([a-zA-Z/]+\.ts:\d+\)/);
        });

        it('should include Location field with markdown link format', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('[src/path/file.ts:42](src/path/file.ts:42)');
        });

        it('should include formatting rule about markdown link format', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('markdown link format for file references');
        });
    });

    describe('output structure', () => {
        it('should include severity guide with emoji indicators', () => {
            const prompt = generator.generateSystemPrompt([]);
            expect(prompt).toContain('🔴 **CRITICAL**');
            expect(prompt).toContain('🟠 **HIGH**');
            expect(prompt).toContain('🟡 **MEDIUM**');
            expect(prompt).toContain('🟢 **LOW/NITPICK**');
        });

        it('should include all required sections in order', () => {
            const prompt = generator.generateSystemPrompt([]);
            const summaryIndex = prompt.indexOf('### 1. Summary');
            const criticalIndex = prompt.indexOf('### 2. Critical Issues');
            const suggestionsIndex = prompt.indexOf('### 3. Suggestions');
            const testIndex = prompt.indexOf('### 4. Test Considerations');
            const positiveIndex = prompt.indexOf("### 5. What's Good");
            const questionsIndex = prompt.indexOf('### 6. Questions for Author');

            expect(summaryIndex).toBeLessThan(criticalIndex);
            expect(criticalIndex).toBeLessThan(suggestionsIndex);
            expect(suggestionsIndex).toBeLessThan(testIndex);
            expect(testIndex).toBeLessThan(positiveIndex);
            expect(positiveIndex).toBeLessThan(questionsIndex);
        });

        it('should place tone_guidelines before Summary section', () => {
            const prompt = generator.generateSystemPrompt([]);
            const toneIndex = prompt.indexOf('<tone_guidelines>');
            const summaryIndex = prompt.indexOf('### 1. Summary');

            expect(toneIndex).toBeLessThan(summaryIndex);
        });

        it('should place certainty_principle after tone_guidelines and before Summary', () => {
            const prompt = generator.generateSystemPrompt([]);
            const toneIndex = prompt.indexOf('</tone_guidelines>');
            const certaintyIndex = prompt.indexOf('<certainty_principle>');
            const summaryIndex = prompt.indexOf('### 1. Summary');

            expect(toneIndex).toBeLessThan(certaintyIndex);
            expect(certaintyIndex).toBeLessThan(summaryIndex);
        });
    });
});
