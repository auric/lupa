import * as z from 'zod';

/**
 * Coerce a value into a string array for flexible LLM input handling.
 * - string: split on newlines, strip bullet markers, drop empty lines
 * - array: pass through (Zod validates items)
 * - null/undefined/other: coerce to empty array
 */
export function coerceToStringArray(val: unknown): unknown {
    if (typeof val === 'string') {
        return val
            .split('\n')
            .map((l) => l.replace(/^[-•*]\s*/, '').trim())
            .filter(Boolean);
    }
    if (Array.isArray(val)) {
        return val;
    }
    return [];
}

/**
 * Accepts both a string[] array and a single multi-line string (which LLMs
 * sometimes produce instead of a proper JSON array).  When a string is
 * received it is split on newlines, stripped of leading bullet markers, and
 * empty lines are dropped.
 *
 * Uses z.preprocess so that z.toJSONSchema produces a clean
 * `{type: "array", items: {type: "string"}}` (with `unrepresentable: "any"`).
 */
export const flexibleStringArray = z.preprocess(
    coerceToStringArray,
    z.array(z.string())
);

/**
 * Like {@link flexibleStringArray} but requires at least one element.
 */
export const flexibleStringArrayNonEmpty = z.preprocess(
    coerceToStringArray,
    z.array(z.string()).min(1)
);
