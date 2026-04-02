import type { ITool } from '../../tools/ITool';
import type { FindingSeverity } from '../../types/findingTypes';

const SEVERITY_ORDER: readonly FindingSeverity[] = [
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL',
] as const;

export function downgradeSeverity(
    severity: string
): FindingSeverity | undefined {
    const idx = SEVERITY_ORDER.indexOf(severity as FindingSeverity);
    if (idx > 0) {
        return SEVERITY_ORDER[idx - 1];
    }
    return undefined;
}

export function filterTools(tools: ITool[], excludeNames: string[]): ITool[] {
    const excluded = new Set(excludeNames);
    return tools.filter((t) => !excluded.has(t.name));
}
