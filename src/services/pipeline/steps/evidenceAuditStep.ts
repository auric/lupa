import { EvidenceAuditor } from '../../evidenceAuditor';
import type {
    PipelineContext,
    PipelineStep,
    PipelineStepResult,
} from '../types';

const SEVERITY_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

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
                if (entry.verdict === 'drop') {
                    findingsDropped.push(entry.finding.title);
                    context.findingStore.remove(entry.finding.id);
                } else if (entry.verdict === 'downgrade') {
                    findingsDowngraded.push(entry.finding.title);
                    const idx = SEVERITY_ORDER.indexOf(entry.finding.severity);
                    if (idx > 0) {
                        context.findingStore.updateSeverity(
                            entry.finding.id,
                            SEVERITY_ORDER[idx - 1]!
                        );
                    }
                }
            }

            return { findingsDropped, findingsDowngraded, toolCallRecords: [] };
        },
    };
}
