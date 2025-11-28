import { describe, it, expect, beforeEach } from 'vitest';
import { ThinkAboutContextTool } from '../tools/thinkAboutContextTool';
import { ThinkAboutTaskTool } from '../tools/thinkAboutTaskTool';
import { ThinkAboutCompletionTool } from '../tools/thinkAboutCompletionTool';

describe('ThinkAboutContextTool', () => {
    let tool: ThinkAboutContextTool;

    beforeEach(() => {
        tool = new ThinkAboutContextTool();
    });

    describe('Tool Configuration', () => {
        it('should have correct name', () => {
            expect(tool.name).toBe('think_about_context');
        });

        it('should have meaningful description', () => {
            expect(tool.description).toContain('reflect');
            expect(tool.description).toContain('context');
        });

        it('should have empty schema (no parameters required)', () => {
            const parsed = tool.schema.safeParse({});
            expect(parsed.success).toBe(true);
        });

        it('should reject unexpected parameters in strict mode', () => {
            const parsed = tool.schema.safeParse({ unexpected: 'value' });
            expect(parsed.success).toBe(false);
        });

        it('should generate valid VS Code tool configuration', () => {
            const vscodeTool = tool.getVSCodeTool();
            expect(vscodeTool.name).toBe('think_about_context');
            expect(vscodeTool.description).toBeDefined();
            expect(vscodeTool.inputSchema).toBeDefined();
        });
    });

    describe('Execution', () => {
        it('should return reflection prompt with key sections', async () => {
            const result = await tool.execute();

            expect(result).toContain('sufficiency');
            expect(result).toContain('relevance');
            expect(result).toContain('dependencies');
            expect(result).toContain('gaps');
        });

        it('should include XML-style structure tags', async () => {
            const result = await tool.execute();

            expect(result).toContain('<context_reflection>');
            expect(result).toContain('</context_reflection>');
            expect(result).toContain('<section');
            expect(result).toContain('</section>');
        });

        it('should include actionable next steps', async () => {
            const result = await tool.execute();

            expect(result).toContain('<next_action>');
            expect(result).toContain('</next_action>');
        });

        it('should mention available tools for filling gaps', async () => {
            const result = await tool.execute();

            expect(result).toContain('find_symbol');
            expect(result).toContain('find_usages');
            expect(result).toContain('search_for_pattern');
        });
    });
});

describe('ThinkAboutTaskTool', () => {
    let tool: ThinkAboutTaskTool;

    beforeEach(() => {
        tool = new ThinkAboutTaskTool();
    });

    describe('Tool Configuration', () => {
        it('should have correct name', () => {
            expect(tool.name).toBe('think_about_task');
        });

        it('should have meaningful description', () => {
            expect(tool.description).toContain('verify');
            expect(tool.description).toContain('track');
        });

        it('should have empty schema (no parameters required)', () => {
            const parsed = tool.schema.safeParse({});
            expect(parsed.success).toBe(true);
        });

        it('should reject unexpected parameters in strict mode', () => {
            const parsed = tool.schema.safeParse({ foo: 'bar' });
            expect(parsed.success).toBe(false);
        });

        it('should generate valid VS Code tool configuration', () => {
            const vscodeTool = tool.getVSCodeTool();
            expect(vscodeTool.name).toBe('think_about_task');
            expect(vscodeTool.description).toBeDefined();
        });
    });

    describe('Execution', () => {
        it('should return reflection prompt with key sections', async () => {
            const result = await tool.execute();

            expect(result).toContain('scope');
            expect(result).toContain('completeness');
            expect(result).toContain('actionability');
            expect(result).toContain('balance');
        });

        it('should include XML-style structure tags', async () => {
            const result = await tool.execute();

            expect(result).toContain('<task_alignment>');
            expect(result).toContain('</task_alignment>');
        });

        it('should include review categories checklist', async () => {
            const result = await tool.execute();

            expect(result).toContain('<review_categories>');
            expect(result).toContain('Bugs');
            expect(result).toContain('Security');
            expect(result).toContain('Performance');
            expect(result).toContain('Code quality');
            expect(result).toContain('Test coverage');
        });

        it('should include actionable next steps', async () => {
            const result = await tool.execute();

            expect(result).toContain('<next_action>');
            expect(result).toContain('</next_action>');
        });
    });
});

describe('ThinkAboutCompletionTool', () => {
    let tool: ThinkAboutCompletionTool;

    beforeEach(() => {
        tool = new ThinkAboutCompletionTool();
    });

    describe('Tool Configuration', () => {
        it('should have correct name', () => {
            expect(tool.name).toBe('think_about_completion');
        });

        it('should have meaningful description', () => {
            expect(tool.description).toContain('done');
            expect(tool.description).toContain('complete');
        });

        it('should have empty schema (no parameters required)', () => {
            const parsed = tool.schema.safeParse({});
            expect(parsed.success).toBe(true);
        });

        it('should reject unexpected parameters in strict mode', () => {
            const parsed = tool.schema.safeParse({ extra: 123 });
            expect(parsed.success).toBe(false);
        });

        it('should generate valid VS Code tool configuration', () => {
            const vscodeTool = tool.getVSCodeTool();
            expect(vscodeTool.name).toBe('think_about_completion');
            expect(vscodeTool.description).toBeDefined();
        });
    });

    describe('Execution', () => {
        it('should return completion verification prompt', async () => {
            const result = await tool.execute();

            expect(result).toContain('coverage');
            expect(result).toContain('issue_categories');
            expect(result).toContain('feedback_quality');
            expect(result).toContain('prioritization');
        });

        it('should include XML-style structure tags', async () => {
            const result = await tool.execute();

            expect(result).toContain('<completion_verification>');
            expect(result).toContain('</completion_verification>');
        });

        it('should include checklists for verification', async () => {
            const result = await tool.execute();

            expect(result).toMatch(/\[ \]/);
            expect(result).toContain('Bugs');
            expect(result).toContain('Security');
            expect(result).toContain('Performance');
        });

        it('should include constructiveness section', async () => {
            const result = await tool.execute();

            expect(result).toContain('constructiveness');
            expect(result).toContain('well-written code');
        });

        it('should include structured final review format', async () => {
            const result = await tool.execute();

            expect(result).toContain('Summary');
            expect(result).toContain('Critical issues');
            expect(result).toContain('Suggestions');
            expect(result).toContain('Positive observations');
        });

        it('should include actionable next steps', async () => {
            const result = await tool.execute();

            expect(result).toContain('<next_action>');
            expect(result).toContain('</next_action>');
        });
    });
});

describe('Think Tools Integration', () => {
    it('should all have consistent structure with XML tags', async () => {
        const tools = [
            new ThinkAboutContextTool(),
            new ThinkAboutTaskTool(),
            new ThinkAboutCompletionTool()
        ];

        for (const tool of tools) {
            const result = await tool.execute();
            expect(result).toContain('<');
            expect(result).toContain('>');
            expect(result).toContain('</');
            expect(result).toContain('<next_action>');
        }
    });

    it('should all have empty schemas', () => {
        const tools = [
            new ThinkAboutContextTool(),
            new ThinkAboutTaskTool(),
            new ThinkAboutCompletionTool()
        ];

        for (const tool of tools) {
            expect(tool.schema.safeParse({}).success).toBe(true);
            expect(tool.schema.safeParse({ any: 'param' }).success).toBe(false);
        }
    });

    it('should have unique names', () => {
        const tools = [
            new ThinkAboutContextTool(),
            new ThinkAboutTaskTool(),
            new ThinkAboutCompletionTool()
        ];

        const names = tools.map(t => t.name);
        const uniqueNames = new Set(names);
        expect(uniqueNames.size).toBe(tools.length);
    });
});
