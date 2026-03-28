import { describe, it, expect, beforeEach } from 'vitest';
import { GetObservationsTool } from '../tools/getObservationsTool';
import { ObservationStore } from '../sessions/observationStore';
import { createMockExecutionContext } from './testUtils/mockFactories';
import type { ExecutionContext } from '../types/executionContext';

describe('GetObservationsTool', () => {
    let tool: GetObservationsTool;
    let store: ObservationStore;
    let context: ExecutionContext;

    beforeEach(() => {
        tool = new GetObservationsTool();
        store = new ObservationStore();
        context = {
            ...createMockExecutionContext(),
            observationStore: store,
        };
    });

    it('has correct name and description', () => {
        expect(tool.name).toBe('get_observations');
        expect(tool.description).toContain('architectural observations');
    });

    it('returns "no observations" message when store is empty', async () => {
        const result = await tool.execute({}, context);

        expect(result.success).toBe(true);
        expect(result.data).toContain('No observations recorded yet');
    });

    it('returns formatted observations', async () => {
        store.add({
            agentId: 'agent-1',
            category: 'pattern',
            title: 'Singleton pattern',
            content: 'Found in multiple services',
            relatedFiles: ['src/a.ts', 'src/b.ts'],
        });

        const result = await tool.execute({}, context);

        expect(result.success).toBe(true);
        expect(result.data).toContain('1 observation(s)');
        expect(result.data).toContain('obs-1');
        expect(result.data).toContain('pattern');
        expect(result.data).toContain('agent-1');
        expect(result.data).toContain('Singleton pattern');
        expect(result.data).toContain('Found in multiple services');
        expect(result.data).toContain('src/a.ts, src/b.ts');
    });

    it('filters by category', async () => {
        store.add({
            agentId: 'agent-1',
            category: 'pattern',
            title: 'Pattern obs',
            content: 'A pattern',
            relatedFiles: [],
        });
        store.add({
            agentId: 'agent-1',
            category: 'concern',
            title: 'Concern obs',
            content: 'A concern',
            relatedFiles: [],
        });

        const result = await tool.execute({ category: 'concern' }, context);

        expect(result.success).toBe(true);
        expect(result.data).toContain('1 observation(s)');
        expect(result.data).toContain('Concern obs');
        expect(result.data).not.toContain('Pattern obs');
    });

    it('filters by related_file', async () => {
        store.add({
            agentId: 'agent-1',
            category: 'dependency',
            title: 'File A obs',
            content: 'About file A',
            relatedFiles: ['src/a.ts'],
        });
        store.add({
            agentId: 'agent-1',
            category: 'dependency',
            title: 'File B obs',
            content: 'About file B',
            relatedFiles: ['src/b.ts'],
        });

        const result = await tool.execute(
            { related_file: 'src/a.ts' },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('1 observation(s)');
        expect(result.data).toContain('File A obs');
        expect(result.data).not.toContain('File B obs');
    });

    it('returns error when observationStore not available', async () => {
        const noStoreContext = createMockExecutionContext();

        const result = await tool.execute({}, noStoreContext);

        expect(result.success).toBe(false);
        expect(result.error).toContain('not available');
    });

    it('shows filter info in empty result message', async () => {
        const result = await tool.execute(
            { category: 'concern', related_file: 'src/foo.ts' },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('No observations recorded yet');
        expect(result.data).toContain('category=concern');
        expect(result.data).toContain('file=src/foo.ts');
    });
});
