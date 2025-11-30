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

            expect(result.success).toBe(true);
            expect(result.data).toContain('sufficiency');
            expect(result.data).toContain('relevance');
            expect(result.data).toContain('dependencies');
            expect(result.data).toContain('gaps');
        });

        it('should include XML-style structure tags', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('<context_reflection>');
            expect(result.data).toContain('</context_reflection>');
            expect(result.data).toContain('<section');
            expect(result.data).toContain('</section>');
        });

        it('should include actionable next steps', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('<next_action>');
            expect(result.data).toContain('</next_action>');
        });

        it('should mention available tools for filling gaps', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('find_symbol');
            expect(result.data).toContain('find_usages');
            expect(result.data).toContain('search_for_pattern');
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

            expect(result.success).toBe(true);
            expect(result.data).toContain('scope');
            expect(result.data).toContain('completeness');
            expect(result.data).toContain('actionability');
            expect(result.data).toContain('balance');
        });

        it('should include XML-style structure tags', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('<task_alignment>');
            expect(result.data).toContain('</task_alignment>');
        });

        it('should include review categories checklist', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('<review_categories>');
            expect(result.data).toContain('Bugs');
            expect(result.data).toContain('Security');
            expect(result.data).toContain('Performance');
            expect(result.data).toContain('Code quality');
            expect(result.data).toContain('Test coverage');
        });

        it('should include actionable next steps', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('<next_action>');
            expect(result.data).toContain('</next_action>');
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

            expect(result.success).toBe(true);
            expect(result.data).toContain('coverage');
            expect(result.data).toContain('issue_categories');
            expect(result.data).toContain('feedback_quality');
            expect(result.data).toContain('prioritization');
        });

        it('should include XML-style structure tags', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('<completion_verification>');
            expect(result.data).toContain('</completion_verification>');
        });

        it('should include checklists for verification', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toMatch(/\[ \]/);
            expect(result.data).toContain('Bugs');
            expect(result.data).toContain('Security');
            expect(result.data).toContain('Performance');
        });

        it('should include constructiveness section', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('constructiveness');
            expect(result.data).toContain('well-written code');
        });

        it('should include structured final review format', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('Summary');
            expect(result.data).toContain('Critical issues');
            expect(result.data).toContain('Suggestions');
            expect(result.data).toContain('Positive observations');
        });

        it('should include actionable next steps', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('<next_action>');
            expect(result.data).toContain('</next_action>');
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
            expect(result.success).toBe(true);
            expect(result.data).toContain('<');
            expect(result.data).toContain('>');
            expect(result.data).toContain('</');
            expect(result.data).toContain('<next_action>');
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
