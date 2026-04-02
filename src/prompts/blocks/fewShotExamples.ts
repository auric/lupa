/**
 * Few-shot examples for dismissive models (GPT-4.1).
 * OpenAI recommends examples under #Examples heading for instruction-following models.
 * Shows correct investigation → finding and correct investigation → dismissal workflows.
 */

import type { ModelCalibrationProfile } from '../../models/modelCalibration';

/**
 * Generate few-shot examples for PR review.
 * Only included for dismissive models — capable models don't need examples
 * and the extra tokens reduce their context for actual analysis.
 */
export function generateFewShotExamples(
    calibration: ModelCalibrationProfile
): string {
    if (calibration.findingBias !== 'dismissive') {
        return '';
    }

    return `<investigation_examples>
## Examples

### Example A: Real Finding Discovered

**Diff shows**: \`parseConfig()\` in \`config.ts\` now returns \`null\` on invalid input (previously threw).

**Investigation**:
\`\`\`
→ find_usages({symbol: "parseConfig", file: "src/config.ts"})
  Result: 3 callers found:
    - loadSettings() at src/settings.ts:45
    - initApp() at src/app.ts:12
    - testHelper() at src/__tests__/helper.ts:30

→ read_file({file_path: "src/settings.ts", start_line: 40, end_line: 55})
  Result: loadSettings() passes parseConfig() result to JSON.stringify() with no null check

→ read_file({file_path: "src/app.ts", start_line: 8, end_line: 20})
  Result: initApp() wraps call in try-catch ✓

→ think({topic: "parseConfig callers", analysis: "loadSettings() at settings.ts:45 passes parseConfig() result directly to JSON.stringify(). parseConfig() now returns null on invalid input. JSON.stringify(null) returns 'null' string — not a crash, but loadSettings() then writes 'null' to disk as the config file, corrupting settings.", identified_risks: ["loadSettings() writes corrupted config when parseConfig() returns null"], next_action: "record finding"})
\`\`\`

**Decision**: loadSettings() at settings.ts:45 will write corrupted config. Caller + scenario + wrong behavior all identified.
→ \`record_finding\` with severity MEDIUM, affected_component "loadSettings()", failure_mechanism "data_corruption"

### Example B: Hypothesis Correctly Dismissed

**Diff shows**: \`validateInput()\` now throws \`ValidationError\` instead of returning \`false\`.

**Investigation**:
\`\`\`
→ find_usages({symbol: "validateInput", file: "src/validator.ts"})
  Result: 4 callers found:
    - handleSubmit() at src/form.ts:22
    - processRequest() at src/api.ts:45
    - batchValidate() at src/batch.ts:10
    - validateAll() at src/bulk.ts:33

→ read_file({file_path: "src/form.ts", start_line: 18, end_line: 30})
  Result: handleSubmit() wraps validateInput() in try-catch, catches ValidationError ✓

→ read_file({file_path: "src/api.ts", start_line: 40, end_line: 55})
  Result: processRequest() wraps in try-catch, catches generic Error ✓

→ read_file({file_path: "src/batch.ts", start_line: 5, end_line: 20})
  Result: batchValidate() wraps in try-catch ✓

→ read_file({file_path: "src/bulk.ts", start_line: 28, end_line: 42})
  Result: validateAll() wraps in try-catch ✓
\`\`\`

**Decision**: All 4 callers handle the new exception. No finding — change is safely handled.
→ Move to next changed function.

### Example C: Pre-existing Issue Correctly Ignored

**Diff shows**: \`DatabaseClient\` class has new \`query()\` method added.

**Investigation**:
\`\`\`
→ read_file({file_path: "src/db.ts", start_line: 1, end_line: 50})
  Result: DatabaseClient has a close() method. The class has no dispose pattern.

→ think({topic: "DatabaseClient resource management", analysis: "The class lacks automatic disposal, but this PR only ADDS a new query() method. The missing dispose pattern is pre-existing — it existed before this PR.", identified_risks: [], next_action: "move to next file"})
\`\`\`

**Decision**: Missing dispose() is pre-existing. This PR adds query(), which does NOT introduce or worsen the resource management issue. NOT a finding — pre-existing issues are out of scope.
→ Do NOT record. Move to next file.
</investigation_examples>`;
}
