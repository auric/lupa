import { describe, it, expect } from 'vitest';
import { ReasoningChain } from '../sessions/reasoningChain';

describe('ReasoningChain', () => {
    describe('checkpoint tracking', () => {
        it('should create checkpoints with sequential numbers', () => {
            const chain = new ReasoningChain();
            const cp1 = chain.addCheckpoint('auth changes', [
                'timing attack',
                'null check',
            ]);
            const cp2 = chain.addCheckpoint('db changes', ['sql injection']);

            expect(cp1.number).toBe(1);
            expect(cp2.number).toBe(2);
            expect(chain.getCheckpointCount()).toBe(2);
        });

        it('should track hypotheses generated at each checkpoint', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth changes', [
                'timing attack',
                'null check',
            ]);

            const hypotheses = chain.getAllHypotheses();
            expect(hypotheses).toHaveLength(2);
            expect(hypotheses[0].text).toBe('timing attack');
            expect(hypotheses[0].status).toBe('generated');
            expect(hypotheses[0].generatedAtCheckpoint).toBe(1);
            expect(hypotheses[1].text).toBe('null check');
        });

        it('should deduplicate identical hypotheses within same status', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth changes', ['timing attack']);
            chain.addCheckpoint('more auth', ['timing attack']);

            expect(chain.getAllHypotheses()).toHaveLength(1);
        });

        it('should track tool calls between checkpoints', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('first', ['risk1']);

            chain.recordToolCall('find_usages');
            chain.recordToolCall('read_file');

            const cp2 = chain.addCheckpoint('second', []);
            expect(cp2.toolCallsSincePrevious).toEqual([
                'find_usages',
                'read_file',
            ]);
            expect(cp2.investigationToolCount).toBe(2);
        });

        it('should reset tool calls after checkpoint', () => {
            const chain = new ReasoningChain();
            chain.recordToolCall('find_usages');
            chain.addCheckpoint('first', []);

            expect(chain.getToolCallsSinceLastCheckpoint()).toHaveLength(0);
        });
    });

    describe('hypothesis status tracking', () => {
        it('should mark hypotheses as investigating', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);

            chain.markInvestigating([1]);
            expect(chain.getAllHypotheses()[0].status).toBe('investigating');
        });

        it('should mark hypotheses as confirmed', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);

            chain.markConfirmed(1, 'found in loadSettings');
            expect(chain.getAllHypotheses()[0].status).toBe('confirmed');
            expect(chain.getAllHypotheses()[0].resolutionNote).toBe(
                'found in loadSettings'
            );
        });

        it('should mark hypotheses as dismissed', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);

            chain.markDismissed(1, 'all callers handle it');
            expect(chain.getAllHypotheses()[0].status).toBe('dismissed');
        });

        it('should not mark investigating if already confirmed', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);
            chain.markConfirmed(1, 'real issue');
            chain.markInvestigating([1]);

            expect(chain.getAllHypotheses()[0].status).toBe('confirmed');
        });
    });

    describe('query methods', () => {
        it('should return uninvestigated hypotheses', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['risk1', 'risk2', 'risk3']);
            chain.markConfirmed(1);
            chain.markDismissed(2);

            const uninvestigated = chain.getUninvestigatedHypotheses();
            expect(uninvestigated).toHaveLength(1);
            expect(uninvestigated[0].text).toBe('risk3');
        });

        it('should return open hypotheses', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['risk1', 'risk2']);
            chain.markConfirmed(1);

            const open = chain.getOpenHypotheses();
            expect(open).toHaveLength(1);
            expect(open[0].text).toBe('risk2');
        });

        it('should detect investigation tools since checkpoint', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('first', []);

            chain.recordToolCall('think');
            chain.recordToolCall('update_plan');
            expect(chain.hasInvestigationSinceLastCheckpoint()).toBe(false);

            chain.recordToolCall('find_usages');
            expect(chain.hasInvestigationSinceLastCheckpoint()).toBe(true);
        });

        it('should count investigation tools correctly', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('first', []);

            chain.recordToolCall('think');
            chain.recordToolCall('find_usages');
            chain.recordToolCall('read_file');
            chain.recordToolCall('update_plan');
            chain.recordToolCall('validate_claim');

            expect(chain.getInvestigationToolCountSinceLastCheckpoint()).toBe(
                3
            );
        });
    });

    describe('hypothesis trail summary', () => {
        it('should return empty message when no hypotheses', () => {
            const chain = new ReasoningChain();
            expect(chain.generateHypothesisTrailSummary()).toContain(
                'No hypotheses'
            );
        });

        it('should include counts in summary', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['risk1', 'risk2', 'risk3']);
            chain.markConfirmed(1);
            chain.markDismissed(2);

            const summary = chain.generateHypothesisTrailSummary();
            expect(summary).toContain('3 total');
            expect(summary).toContain('1 confirmed');
            expect(summary).toContain('1 dismissed');
            expect(summary).toContain('1 uninvestigated');
        });

        it('should list uninvestigated hypotheses with warning', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);

            const summary = chain.generateHypothesisTrailSummary();
            expect(summary).toContain('UNINVESTIGATED');
            expect(summary).toContain('timing attack');
        });
    });

    describe('isolation', () => {
        it('should not share state between separate instances', () => {
            const chain1 = new ReasoningChain();
            const chain2 = new ReasoningChain();

            chain1.addCheckpoint('agent1 topic', ['risk from agent 1']);
            chain1.recordToolCall('find_usages');
            chain1.recordToolCall('read_file');

            chain2.addCheckpoint('agent2 topic', ['risk from agent 2']);
            chain2.recordToolCall('validate_claim');

            // Chain1 should not see chain2's tool calls or hypotheses
            expect(chain1.getAllHypotheses()).toHaveLength(1);
            expect(chain1.getAllHypotheses()[0].text).toBe('risk from agent 1');
            expect(chain1.getToolCallsSinceLastCheckpoint()).toEqual([
                'find_usages',
                'read_file',
            ]);

            // Chain2 should not see chain1's tool calls or hypotheses
            expect(chain2.getAllHypotheses()).toHaveLength(1);
            expect(chain2.getAllHypotheses()[0].text).toBe('risk from agent 2');
            expect(chain2.getToolCallsSinceLastCheckpoint()).toEqual([
                'validate_claim',
            ]);
        });

        it('should not have checkpoint reset affect other instances', () => {
            const chain1 = new ReasoningChain();
            const chain2 = new ReasoningChain();

            chain1.recordToolCall('find_usages');
            chain2.recordToolCall('read_file');

            // Chain1 adds checkpoint, which resets its tool calls
            chain1.addCheckpoint('reset test', []);

            // Chain2's tool calls should be unaffected
            expect(chain2.getToolCallsSinceLastCheckpoint()).toEqual([
                'read_file',
            ]);
            expect(chain2.getInvestigationToolCountSinceLastCheckpoint()).toBe(
                1
            );

            // Chain1's tool calls should be reset
            expect(chain1.getToolCallsSinceLastCheckpoint()).toEqual([]);
        });
    });
});
