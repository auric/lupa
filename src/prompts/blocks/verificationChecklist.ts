/**
 * Systematic verification checklist for dismissive models.
 * Converts open-ended review into structured checkpoint verification.
 * Each item maps to a specific tool call.
 */

import type { ModelCalibrationProfile } from '../../models/modelCalibration';

/**
 * Generate a systematic verification checklist for PR review.
 * For dismissive models: detailed checklist with tool mappings.
 * For other models: lightweight checklist (they don't need hand-holding).
 */
export function generateVerificationChecklist(
    calibration: ModelCalibrationProfile
): string {
    if (calibration.findingBias !== 'dismissive') {
        return '';
    }

    return `<verification_checklist>
## Systematic Verification Checklist

For each changed file, execute this checklist. Check off each item with the tool that verified it.

### Per-Function Checks (for each changed function/method)
- [ ] **Caller compatibility**: \`find_usages\` → do all callers handle new behavior?
- [ ] **Error propagation**: Does the function throw new errors? → Do callers catch them?
- [ ] **Null/undefined paths**: Does the function return null/undefined in new cases? → Do callers check?
- [ ] **Type changes**: Did parameter or return types change? → Do callers match?
- [ ] **Removed code**: Was validation or error handling removed? → Do callers depend on it?

### Per-File Checks (after all functions in a file)
- [ ] **New imports used**: Are all new imports actually called? (check with \`find_usages\`)
- [ ] **Resource lifecycle**: New resource acquired (connection, handle, stream)? → Is it released?
- [ ] **Error boundaries**: New error paths → Are they caught before reaching the user?

### Cross-File Checks (after all files reviewed)
- [ ] **API contract**: Changed interfaces/types → All implementations updated?
- [ ] **Integration points**: Changed function signatures → All call sites updated?
- [ ] **Configuration**: New config options → Defaults sensible? Missing options handled?

**Completion rule**: You may call \`think_about_completion\` only after checking at least the per-function items for every changed function. Missing checks must be noted in your completion summary.
</verification_checklist>`;
}
