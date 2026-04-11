import { EvidenceAuditor } from '../../evidenceAuditor';
import {
    dismissHypothesesForDroppedFinding,
    downgradeSeverity,
} from '../pipelineUtils';
import type {
    PipelineContext,
    PipelineStep,
    PipelineStepResult,
} from '../pipelineTypes';

export function createEvidenceAuditStep(): PipelineStep {
    return {
        name: 'evidence-audit',
        label: 'Evidence Audit',
        description:
            'Cross-references tool call logs against findings to detect fabricated or unsupported evidence',
        kind: 'programmatic',

        shouldRun(context: PipelineContext): boolean {
            return context.findingStore.size > 0;
        },

        async execute(context: PipelineContext): Promise<PipelineStepResult> {
            const findingsDropped: string[] = [];
            const findingsDowngraded: string[] = [];

            context.progressCallback?.('Auditing evidence trail...', 0.3);

            const findings = context.findingStore.getAll();
            const evidenceAuditor = new EvidenceAuditor();
            const auditResult = evidenceAuditor.audit(
                findings,
                context.toolCallRecords
            );

            for (const entry of auditResult.entries) {
                switch (entry.verdict) {
                    case 'drop':
                        findingsDropped.push(entry.finding.title);
                        context.findingStore.remove(entry.finding.id);
                        dismissHypothesesForDroppedFinding(
                            entry.finding.id,
                            context.executionContext.reasoningChain,
                            'Finding dropped by evidence audit'
                        );
                        break;
                    case 'downgrade':
                    case 'weak-evidence': {
                        const newSeverity = downgradeSeverity(
                            entry.finding.severity
                        );
                        if (newSeverity) {
                            findingsDowngraded.push(entry.finding.title);
                            context.findingStore.updateSeverity(
                                entry.finding.id,
                                newSeverity
                            );
                        }
                        break;
                    }
                    case 'keep':
                        break;
                    default: {
                        const _exhaustive: never = entry.verdict;
                        break;
                    }
                }
            }

            return { findingsDropped, findingsDowngraded, toolCallRecords: [] };
        },
    };
}
