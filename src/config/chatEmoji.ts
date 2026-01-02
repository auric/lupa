/**
 * Centralized emoji constants for chat responses.
 * All emoji are chosen to be distinguishable by shape (accessibility requirement UX-NFR-001).
 * @see docs/ux-design-specification.md#emoji-design-system
 */

/**
 * Issue severity levels - used for code review findings.
 * These represent actual problem severity (critical → low).
 */
const ISSUE_SEVERITIES = {
    /** 🔴 Critical issue - must fix before shipping */
    critical: '🔴',
    /** 🟠 High severity issue - should fix */
    high: '🟠',
    /** 🟡 Medium severity issue - should fix soon */
    medium: '🟡',
    /** 🟢 Low severity issue - nice to have */
    low: '🟢',
} as const;

/**
 * UI state indicators - not issue severities, but status/feedback states.
 */
const UI_STATES = {
    /** 🟡 Suggestion - consider improving (alias for medium) */
    suggestion: '🟡',
    /** ✅ Success - positive confirmation */
    success: '✅',
    /** ⚠️ Warning - caution needed */
    warning: '⚠️',
} as const;

/**
 * Combined severity indicators - used for finding cards and status messages.
 * Circle shapes with different fills, plus checkmark for success.
 */
export const SEVERITY = {
    ...ISSUE_SEVERITIES,
    ...UI_STATES,
} as const;

/**
 * Activity indicators - shown during analysis progress.
 */
export const ACTIVITY = {
    /** 💭 AI is reasoning/thinking */
    thinking: '💭',
    /** 🔍 Finding symbols, searching definitions */
    searching: '🔍',
    /** 📂 Reading files */
    reading: '📂',
    /** 🔎 Deep code inspection */
    analyzing: '🔎',
} as const;

/**
 * Section markers - used for response structure headers.
 */
export const SECTION = {
    /** 🔒 Security-related findings */
    security: '🔒',
    /** 🧪 Testing suggestions */
    testing: '🧪',
    /** 📊 Summary statistics */
    summary: '📊',
    /** 📁 File listings */
    files: '📁',
} as const;

/** Type for severity indicator keys */
export type SeverityType = keyof typeof SEVERITY;

/** Type for issue severity keys - derived from ISSUE_SEVERITIES, no duplication */
export type IssueSeverity = keyof typeof ISSUE_SEVERITIES;

/**
 * Runtime array of issue severity values for Zod enum validation.
 * Derived from ISSUE_SEVERITIES keys to stay in sync automatically.
 */
export const ISSUE_SEVERITY_VALUES = Object.keys(ISSUE_SEVERITIES) as [
    IssueSeverity,
    ...IssueSeverity[],
];

/** Type for activity indicator keys */
export type ActivityType = keyof typeof ACTIVITY;

/** Type for section marker keys */
export type SectionType = keyof typeof SECTION;
