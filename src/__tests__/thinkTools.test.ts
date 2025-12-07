import { describe, it, expect, beforeEach } from 'vitest';
import { ThinkAboutContextTool } from '../tools/thinkAboutContextTool';
import { ThinkAboutTaskTool } from '../tools/thinkAboutTaskTool';
import { ThinkAboutCompletionTool } from '../tools/thinkAboutCompletionTool';
import { ThinkAboutInvestigationTool } from '../tools/thinkAboutInvestigationTool';

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
            expect(result.data).toContain('Context Evaluation');
            expect(result.data).toContain('Diff Coverage Check');
            expect(result.data).toContain('Understanding Check');
            expect(result.data).toContain('Gap Identification');
        });

        it('should include Markdown structure with checkboxes', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('##');
            expect(result.data).toContain('###');
            expect(result.data).toContain('□'); // Unicode checkbox
        });

        it('should include subagent consideration section', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('Subagent Consideration');
            expect(result.data).toContain('subagent');
        });

        it('should include decision guidance', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('Decision');
            expect(result.data).toContain('Context sufficient');
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
            expect(result.data).toContain('Task Alignment Check');
            expect(result.data).toContain('Scope Verification');
            expect(result.data).toContain('Review Coverage');
            expect(result.data).toContain('Finding Quality');
        });

        it('should include Markdown structure with checkboxes', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('##');
            expect(result.data).toContain('###');
            expect(result.data).toContain('□');
        });

        it('should include review categories checklist', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('Bugs');
            expect(result.data).toContain('Security');
            expect(result.data).toContain('Performance');
            expect(result.data).toContain('Code quality');
            expect(result.data).toContain('Error handling');
        });

        it('should include balance check section', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('Balance Check');
            expect(result.data).toContain('constructive');
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
            expect(result.data).toContain('Completion Verification');
            expect(result.data).toContain('Structure Check');
            expect(result.data).toContain('Quality Check');
            expect(result.data).toContain('Completeness Check');
        });

        it('should include Markdown structure with checkboxes', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('##');
            expect(result.data).toContain('###');
            expect(result.data).toContain('□');
        });

        it('should include tone check section', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('Tone Check');
            expect(result.data).toContain('constructive');
            expect(result.data).toContain('professional');
        });

        it('should include format check mentioning Markdown', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('Format Check');
            expect(result.data).toContain('Markdown');
            expect(result.data).toContain('🔴');
            expect(result.data).toContain('🟠');
        });

        it('should include structured final review format', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('Summary');
            expect(result.data).toContain('Critical Issues');
            expect(result.data).toContain('Suggestions');
            expect(result.data).toContain('Positive Observations');
        });
    });
});

describe('ThinkAboutInvestigationTool', () => {
    let tool: ThinkAboutInvestigationTool;

    beforeEach(() => {
        tool = new ThinkAboutInvestigationTool();
    });

    describe('Tool Configuration', () => {
        it('should have correct name', () => {
            expect(tool.name).toBe('think_about_investigation');
        });

        it('should have meaningful description', () => {
            expect(tool.description).toContain('investigation');
            expect(tool.description).toContain('progress');
        });

        it('should have empty schema (no parameters required)', () => {
            const parsed = tool.schema.safeParse({});
            expect(parsed.success).toBe(true);
        });

        it('should reject unexpected parameters in strict mode', () => {
            const parsed = tool.schema.safeParse({ param: true });
            expect(parsed.success).toBe(false);
        });
    });

    describe('Execution', () => {
        it('should return investigation progress prompt', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('Investigation Progress Check');
            expect(result.data).toContain('Task Focus');
            expect(result.data).toContain('Evidence Gathered');
            expect(result.data).toContain('Tool Budget');
        });

        it('should include deliverable readiness section', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('Deliverable Readiness');
        });

        it('should include decision guidance', async () => {
            const result = await tool.execute();

            expect(result.success).toBe(true);
            expect(result.data).toContain('Decision');
            expect(result.data).toContain('Investigation complete');
        });
    });
});

describe('Think Tools Integration', () => {
    it('should all have consistent Markdown structure', async () => {
        const tools = [
            new ThinkAboutContextTool(),
            new ThinkAboutTaskTool(),
            new ThinkAboutCompletionTool(),
            new ThinkAboutInvestigationTool()
        ];

        for (const tool of tools) {
            const result = await tool.execute();
            expect(result.success).toBe(true);
            expect(result.data).toContain('##');
            expect(result.data).toContain('###');
            expect(result.data).toContain('Decision');
        }
    });

    it('should all have empty schemas', () => {
        const tools = [
            new ThinkAboutContextTool(),
            new ThinkAboutTaskTool(),
            new ThinkAboutCompletionTool(),
            new ThinkAboutInvestigationTool()
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
            new ThinkAboutCompletionTool(),
            new ThinkAboutInvestigationTool()
        ];

        const names = tools.map(t => t.name);
        const uniqueNames = new Set(names);
        expect(uniqueNames.size).toBe(tools.length);
    });
});
