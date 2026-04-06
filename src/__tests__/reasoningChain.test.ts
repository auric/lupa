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

        it('should skip empty and whitespace-only hypothesis text', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('test', ['', '  ', 'valid hypothesis', '\t\n']);
            const hyps = chain.getAllHypotheses();
            expect(hyps).toHaveLength(1);
            expect(hyps[0].text).toBe('valid hypothesis');
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

        it('markConfirmed does not re-confirm a dismissed hypothesis', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);
            chain.markDismissed(1, 'disproved');

            chain.markConfirmed(1, 'trying to re-confirm');

            expect(chain.getAllHypotheses()[0].status).toBe('dismissed');
        });

        it('markDismissed does not dismiss a confirmed hypothesis', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);
            chain.markConfirmed(1, 'real issue');

            chain.markDismissed(1, 'trying to dismiss');

            expect(chain.getAllHypotheses()[0].status).toBe('confirmed');
        });

        it('markConfirmed does not affect abandoned hypothesis', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);

            // Manually set to abandoned via direct mutation (abandoned is a terminal state)
            const h = chain.getAllHypotheses()[0];
            (h as { status: string }).status = 'abandoned';

            chain.markConfirmed(1, 'trying to confirm abandoned');

            expect(chain.getAllHypotheses()[0].status).toBe('abandoned');
        });

        it('markConfirmed stores confirmedByFindingId', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('error handling', ['missing error handler']);

            chain.markConfirmed(1, 'confirmed note', 'finding-1');

            const h = chain.getAllHypotheses()[0];
            expect(h.status).toBe('confirmed');
            expect(h.confirmedByFindingId).toBe('finding-1');
        });

        it('revertToInvestigating clears confirmedByFindingId', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('error handling', ['missing error handler']);

            chain.markConfirmed(1, 'confirmed note', 'finding-1');
            expect(chain.getAllHypotheses()[0].confirmedByFindingId).toBe(
                'finding-1'
            );

            chain.revertToInvestigating(1, 'reverted');

            const h = chain.getAllHypotheses()[0];
            expect(h.status).toBe('investigating');
            expect(h.confirmedByFindingId).toBeUndefined();
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

    describe('recordToolCall auto-transition', () => {
        it('recordToolCall with investigation tool auto-transitions generated hypotheses to investigating', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack', 'null check']);

            // Both should start as 'generated'
            expect(chain.getAllHypotheses()[0].status).toBe('generated');
            expect(chain.getAllHypotheses()[1].status).toBe('generated');

            chain.recordToolCall('find_usages');

            // Both should now be 'investigating'
            expect(chain.getAllHypotheses()[0].status).toBe('investigating');
            expect(chain.getAllHypotheses()[1].status).toBe('investigating');
        });

        it('recordToolCall with investigation tool populates investigationTools on investigating hypotheses', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);

            chain.recordToolCall('find_usages');
            chain.recordToolCall('read_file');

            const h = chain.getAllHypotheses()[0];
            expect(h.status).toBe('investigating');
            expect(h.investigationTools).toEqual(['find_usages', 'read_file']);
        });

        it('recordToolCall with non-investigation tool does not transition hypotheses', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);

            chain.recordToolCall('think');
            chain.recordToolCall('update_plan');

            expect(chain.getAllHypotheses()[0].status).toBe('generated');
            expect(chain.getAllHypotheses()[0].investigationTools).toEqual([]);
        });

        it('getUninvestigatedHypotheses returns empty after investigation tools called', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['risk1', 'risk2']);

            // Before investigation: both uninvestigated
            expect(chain.getUninvestigatedHypotheses()).toHaveLength(2);

            chain.recordToolCall('find_usages');

            // After investigation: auto-transitioned to 'investigating', no longer 'generated'
            expect(chain.getUninvestigatedHypotheses()).toHaveLength(0);
        });

        it('auto-transition does not affect already confirmed or dismissed hypotheses', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['risk1', 'risk2', 'risk3']);

            chain.markConfirmed(1, 'found issue');
            chain.markDismissed(2, 'disproved');

            chain.recordToolCall('read_file');

            expect(chain.getAllHypotheses()[0].status).toBe('confirmed');
            expect(chain.getAllHypotheses()[1].status).toBe('dismissed');
            // Only the 'generated' one should transition
            expect(chain.getAllHypotheses()[2].status).toBe('investigating');
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

    describe('createSnapshot / restoreSnapshot', () => {
        it('should restore hypotheses to snapshot state', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);

            const snapshot = chain.createSnapshot();

            chain.addCheckpoint('db', ['sql injection']);

            expect(chain.getAllHypotheses()).toHaveLength(2);

            chain.restoreSnapshot(snapshot);

            expect(chain.getAllHypotheses()).toHaveLength(1);
            expect(chain.getAllHypotheses()[0].text).toBe('timing attack');
        });

        it('should restore checkpoints and tool call tracking', () => {
            const chain = new ReasoningChain();
            chain.recordToolCall('find_usages');
            chain.recordToolCall('read_file');
            chain.addCheckpoint('first', ['risk1']);

            const snapshot = chain.createSnapshot();

            chain.recordToolCall('validate_claim');
            chain.addCheckpoint('second', ['risk2']);

            expect(chain.getCheckpointCount()).toBe(2);
            expect(chain.getAllHypotheses()).toHaveLength(2);

            chain.restoreSnapshot(snapshot);

            expect(chain.getCheckpointCount()).toBe(1);
            expect(chain.getAllHypotheses()).toHaveLength(1);
            expect(chain.getToolCallsSinceLastCheckpoint()).toHaveLength(0);
        });

        it('should produce independent deep copies', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);

            const snapshot = chain.createSnapshot();

            // Modify original
            chain.markConfirmed(1, 'found issue');
            chain.addCheckpoint('db', ['sql injection']);

            // Snapshot should be unaffected — verify by restoring
            chain.restoreSnapshot(snapshot);

            expect(chain.getAllHypotheses()).toHaveLength(1);
            expect(chain.getAllHypotheses()[0].status).toBe('generated');
            expect(chain.getCheckpointCount()).toBe(1);
        });
    });

    describe('revertToInvestigating', () => {
        it('reverts confirmed hypothesis to investigating', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);
            chain.markConfirmed(1, 'found in loadSettings');

            chain.revertToInvestigating(1, 'Finding retracted');

            const h = chain.getAllHypotheses()[0];
            expect(h.status).toBe('investigating');
            expect(h.resolutionNote).toBe('Finding retracted');
        });

        it('does not revert non-confirmed hypothesis', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);

            // hypothesis is 'generated' — should not be reverted
            chain.revertToInvestigating(1, 'Finding retracted');

            expect(chain.getAllHypotheses()[0].status).toBe('generated');
        });

        it('does not revert dismissed hypothesis', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);
            chain.markDismissed(1, 'disproved');

            chain.revertToInvestigating(1, 'Finding retracted');

            expect(chain.getAllHypotheses()[0].status).toBe('dismissed');
        });
    });

    describe('dismissConfirmedForFinding', () => {
        it('dismisses a confirmed hypothesis linked to the specified finding', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('error handling', ['missing null check']);
            chain.markConfirmed(1, 'confirmed', 'finding-1');

            chain.dismissConfirmedForFinding(
                'finding-1',
                'Finding dropped by evidence audit'
            );

            const h = chain.getAllHypotheses()[0];
            expect(h.status).toBe('dismissed');
            expect(h.resolutionNote).toBe('Finding dropped by evidence audit');
            expect(h.confirmedByFindingId).toBeUndefined();
        });

        it('does not dismiss hypotheses linked to other findings', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('errors', ['null check', 'type coercion']);
            chain.markConfirmed(1, 'confirmed', 'finding-1');
            chain.markConfirmed(2, 'confirmed', 'finding-2');

            chain.dismissConfirmedForFinding('finding-1', 'dropped');

            expect(chain.getAllHypotheses()[0].status).toBe('dismissed');
            expect(chain.getAllHypotheses()[1].status).toBe('confirmed');
            expect(chain.getAllHypotheses()[1].confirmedByFindingId).toBe(
                'finding-2'
            );
        });

        it('does not dismiss non-confirmed hypotheses', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['risk1', 'risk2', 'risk3']);
            // risk1 stays generated, risk2 is investigating, risk3 is dismissed
            chain.markInvestigating([2]);
            chain.markDismissed(3, 'already dismissed');

            chain.dismissConfirmedForFinding('finding-1', 'dropped');

            expect(chain.getAllHypotheses()[0].status).toBe('generated');
            expect(chain.getAllHypotheses()[1].status).toBe('investigating');
            expect(chain.getAllHypotheses()[2].status).toBe('dismissed');
        });

        it('is a no-op when no hypotheses match the finding ID', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);
            chain.markConfirmed(1, 'confirmed', 'finding-99');

            chain.dismissConfirmedForFinding('finding-1', 'dropped');

            expect(chain.getAllHypotheses()[0].status).toBe('confirmed');
            expect(chain.getAllHypotheses()[0].confirmedByFindingId).toBe(
                'finding-99'
            );
        });

        it('is a no-op on an empty chain', () => {
            const chain = new ReasoningChain();
            chain.dismissConfirmedForFinding('finding-1', 'dropped');
            expect(chain.getAllHypotheses()).toHaveLength(0);
        });

        it('dismisses multiple hypotheses confirmed by the same finding', () => {
            const chain = new ReasoningChain();
            chain.addCheckpoint('errors', ['null check', 'type error']);
            chain.markConfirmed(1, 'confirmed', 'finding-1');
            chain.markConfirmed(2, 'also confirmed', 'finding-1');

            chain.dismissConfirmedForFinding('finding-1', 'dropped by scoring');

            expect(chain.getAllHypotheses()[0].status).toBe('dismissed');
            expect(chain.getAllHypotheses()[1].status).toBe('dismissed');
        });
    });
});
