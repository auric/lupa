import { describe, it, expect, beforeEach } from 'vitest';
import { ToolAwareSystemPromptGenerator } from '../prompts/toolAwareSystemPromptGenerator';
import { DEFAULT_PROFILE } from '../models/modelCalibration';

describe('ToolAwareSystemPromptGenerator', () => {
    let generator: ToolAwareSystemPromptGenerator;

    beforeEach(() => {
        generator = new ToolAwareSystemPromptGenerator();
    });

    describe('generateSystemPrompt', () => {
        it('should generate a comprehensive system prompt with no tools', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);

            expect(prompt).toContain('Staff Engineer');
            expect(prompt).toContain('bugs');
            expect(prompt).toContain('security');
            expect(prompt).toContain('feedback');
        });

        it('should include tool selection guide', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);

            expect(prompt).toContain('<tool_selection_guide>');
            expect(prompt).toContain('Tool Selection');
            expect(prompt).toContain('| Need |');
            expect(prompt).toContain('Principles');
            expect(prompt).toContain('Anti-Patterns');
        });

        it('should include subagent delegation guidance', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);

            expect(prompt).toContain('<subagent_guidance>');
            expect(prompt).toContain('Subagent');
            expect(prompt).toContain('4+');
            expect(prompt).toContain('Security');
            expect(prompt).toContain('Task Format');
            expect(prompt).toContain('Subagent Diff Access');
        });

        it('should include analysis methodology section', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);

            expect(prompt).toContain('<analysis_methodology>');
            expect(prompt).toContain('Analysis Process');
            expect(prompt).toContain('Create Your Plan');
            expect(prompt).toContain('Gather Context');
            expect(prompt).toContain('update_plan');
            expect(prompt).toContain('Critical Thinking');
        });

        it('should include output format guidance with Markdown structure', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);

            expect(prompt).toContain('<output_format>');
            expect(prompt).toContain('Review Format');
            expect(prompt).toContain('Summary');
            expect(prompt).toContain('Findings');
            expect(prompt).toContain('Severity');
            expect(prompt).toContain('🔴');
            expect(prompt).toContain('🟠');
            expect(prompt).toContain('🟡');
            expect(prompt).toContain('🟢');
        });

        it('should include self-reflection guidance', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);

            expect(prompt).toContain('<self_reflection>');
            expect(prompt).toContain('think');
            expect(prompt).toContain('think_about_completion');
        });

        it('should include quality guidance in prompt', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);

            expect(prompt).toContain('Revert Test');
            expect(prompt).toContain('finding_quality');
        });

        it('should include analysis methodology and review submission sections', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);

            expect(prompt).toContain('analysis_methodology');
            expect(prompt).toContain('submit_review');
        });

        it('should maintain consistent structure and formatting', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);

            // Check that the prompt has proper section ordering
            const roleIndex = prompt.indexOf('Staff Engineer');
            const methodologyIndex = prompt.indexOf('<analysis_methodology>');
            const outputIndex = prompt.indexOf('<output_format>');

            expect(roleIndex).toBeLessThan(methodologyIndex);
            expect(methodologyIndex).toBeLessThan(outputIndex);
        });
    });

    describe('schema extraction', () => {
        it('should handle tools with empty or malformed schemas gracefully', () => {
            expect(() => {
                generator.generateSystemPrompt(DEFAULT_PROFILE);
            }).not.toThrow();
        });

        it('should handle tools with no parameter descriptions', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);
            expect(prompt).toContain('output_format');
        });
    });

    describe('Subagent guidance', () => {
        it('should always show subagent diff access guidance', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);

            expect(prompt).toContain('Subagent Diff Access');
            expect(prompt).toContain('get_file_diff');
            expect(prompt).not.toContain('Subagents CANNOT see the diff');
        });

        it('should include diff tool names when diff tools are present', () => {
            const prompt = generator.generateSystemPrompt(DEFAULT_PROFILE);

            expect(prompt).toContain('Subagent Diff Access');
            expect(prompt).toContain('get_file_diff');
        });
    });
});
