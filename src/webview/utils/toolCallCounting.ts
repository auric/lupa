import type { ToolCallRecord } from '../../types/toolCallTypes';

/**
 * Recursively count all tool calls including nested subagent calls.
 */
export function countAllCalls(calls: ToolCallRecord[]): number {
    let count = 0;
    for (const call of calls) {
        count++;
        if (call.nestedCalls?.length) {
            count += countAllCalls(call.nestedCalls);
        }
    }
    return count;
}
