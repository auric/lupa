import { describe, it, expect, beforeEach } from 'vitest';
import { NoteObservationTool } from '../tools/noteObservationTool';
import { ObservationStore } from '../sessions/observationStore';
import { createMockExecutionContext } from './testUtils/mockFactories';
import type { ExecutionContext } from '../types/executionContext';

describe('NoteObservationTool', () => {
    let tool: NoteObservationTool;
    let store: ObservationStore;
    let context: ExecutionContext;

    beforeEach(() => {
        tool = new NoteObservationTool();
        store = new ObservationStore();
        context = {
            ...createMockExecutionContext(),
            observationStore: store,
        };
    });

    it('has correct name and description', () => {
        expect(tool.name).toBe('note_observation');
        expect(tool.description).toContain('architectural observation');
    });

    it('records observation successfully', async () => {
        const result = await tool.execute(
            {
                category: 'pattern',
                title: 'Singleton usage',
                content: 'Found singleton pattern in multiple services',
                related_files: ['src/serviceA.ts', 'src/serviceB.ts'],
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('obs-1');
        expect(result.data).toContain('Singleton usage');
        expect(result.data).toContain('pattern');
        expect(store.size).toBe(1);

        const obs = store.getAll()[0]!;
        expect(obs.category).toBe('pattern');
        expect(obs.title).toBe('Singleton usage');
        expect(obs.content).toBe(
            'Found singleton pattern in multiple services'
        );
        expect(obs.relatedFiles).toEqual([
            'src/serviceA.ts',
            'src/serviceB.ts',
        ]);
    });

    it('returns error when observationStore not available', async () => {
        const noStoreContext = createMockExecutionContext();

        const result = await tool.execute(
            {
                category: 'concern',
                title: 'Test',
                content: 'Test content',
            },
            noStoreContext
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('not available');
    });

    it('uses currentAgentId from context', async () => {
        const agentContext: ExecutionContext = {
            ...createMockExecutionContext(),
            observationStore: store,
            currentAgentId: 'security-agent',
        };

        await tool.execute(
            {
                category: 'concern',
                title: 'SQL injection risk',
                content: 'Unsanitized input in query builder',
            },
            agentContext
        );

        expect(store.getAll()[0]!.agentId).toBe('security-agent');
    });

    it('handles missing related_files as empty array', async () => {
        await tool.execute(
            {
                category: 'convention',
                title: 'Naming convention',
                content: 'Uses camelCase consistently',
            },
            context
        );

        expect(store.getAll()[0]!.relatedFiles).toEqual([]);
    });

    it('returns count of total observations', async () => {
        await tool.execute(
            {
                category: 'pattern',
                title: 'First',
                content: 'First observation',
            },
            context
        );

        const result = await tool.execute(
            {
                category: 'pattern',
                title: 'Second',
                content: 'Second observation',
            },
            context
        );

        expect(result.data).toContain('Total observations: 2');
    });
});
