/**
 * Centralized emoji constants for chat responses.
 * All emoji are chosen to be distinguishable by shape (accessibility requirement UX-NFR-001).
 * @see docs/ux-design-specification.md#emoji-design-system
 */

/**
 * Severity indicators - used for finding cards and status messages.
 * Circle shapes with different fills, plus checkmark for success.
 */
export const SEVERITY = {
    /** 🔴 Critical issue - must fix before shipping */
    critical: "🔴",
    /** 🟡 Suggestion - consider improving */
    suggestion: "🟡",
    /** ✅ Success - positive confirmation */
    success: "✅",
    /** ⚠️ Warning - caution needed */
    warning: "⚠️",
} as const;

/**
 * Activity indicators - shown during analysis progress.
 */
export const ACTIVITY = {
    /** 💭 AI is reasoning/thinking */
    thinking: "💭",
    /** 🔍 Finding symbols, searching definitions */
    searching: "🔍",
    /** 📂 Reading files */
    reading: "📂",
    /** 🔎 Deep code inspection */
    analyzing: "🔎",
} as const;

/**
 * Section markers - used for response structure headers.
 */
export const SECTION = {
    /** 🔒 Security-related findings */
    security: "🔒",
    /** 🧪 Testing suggestions */
    testing: "🧪",
    /** 📊 Summary statistics */
    summary: "📊",
    /** 📁 File listings */
    files: "📁",
} as const;

/** Type for severity indicator keys */
export type SeverityType = keyof typeof SEVERITY;

/** Type for activity indicator keys */
export type ActivityType = keyof typeof ACTIVITY;

/** Type for section marker keys */
export type SectionType = keyof typeof SECTION;
