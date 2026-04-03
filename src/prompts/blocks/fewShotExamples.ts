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

These investigation patterns apply to any programming language.

### Example A: Real Finding Discovered

**Diff shows**: \`parse_config()\` in \`config.py\` now returns \`None\` on invalid input (previously raised \`ConfigError\`).

**Investigation**:
\`\`\`
→ find_usages({symbol_name: "parse_config", file_path: "src/config.py"})
  Result: 3 callers found:
    - load_settings() at src/settings.py:45
    - init_app() at src/app.py:12
    - test_helper() at tests/test_helper.py:30

→ read_file({file_path: "src/settings.py", start_line: 40, end_line: 55})
  Result: load_settings() passes parse_config() result to json.dumps() with no None check

→ read_file({file_path: "src/app.py", start_line: 8, end_line: 20})
  Result: init_app() wraps call in try-except ✓

→ think({topic: "parse_config callers", analysis: "load_settings() at settings.py:45 passes parse_config() result directly to json.dumps(). parse_config() now returns None on invalid input. json.dumps(None) returns 'null' string — not a crash, but load_settings() then writes 'null' to disk as the config file, corrupting settings.", identified_risks: ["load_settings() writes corrupted config when parse_config() returns None"], next_action: "record finding"})
\`\`\`

**Decision**: load_settings() at settings.py:45 will write corrupted config. Caller + scenario + wrong behavior all identified.
→ \`record_finding({
    severity: "MEDIUM",
    category: "data_integrity",
    title: "load_settings() writes corrupted config when parse_config() returns None",
    file: "src/settings.py",
    line: 45,
    description: "parse_config() now returns None on invalid input. load_settings() passes the result directly to json.dumps() with no None guard, writing the string 'null' to disk and corrupting the settings file.",
    verification_evidence: "read_file on src/settings.py:40-55 shows json.dumps(parse_config(...)) with no None check",
    disproof_note: "Checked init_app() — it wraps in try-except and handles None. load_settings() has no such guard.",
    affected_component: "load_settings()",
    failure_mechanism: "data_corruption"
  })\`

### Example B: Hypothesis Correctly Dismissed

**Diff shows**: \`validateInput()\` in \`Validator.java\` now throws \`ValidationException\` instead of returning \`false\`.

**Investigation**:
\`\`\`
→ find_usages({symbol_name: "validateInput", file_path: "src/Validator.java"})
  Result: 4 callers found:
    - handleSubmit() at src/FormHandler.java:22
    - processRequest() at src/ApiController.java:45
    - batchValidate() at src/BatchProcessor.java:10
    - validateAll() at src/BulkValidator.java:33

→ read_file({file_path: "src/FormHandler.java", start_line: 18, end_line: 30})
  Result: handleSubmit() wraps validateInput() in try-catch, catches ValidationException ✓

→ read_file({file_path: "src/ApiController.java", start_line: 40, end_line: 55})
  Result: processRequest() wraps in try-catch, catches Exception ✓

→ read_file({file_path: "src/BatchProcessor.java", start_line: 5, end_line: 20})
  Result: batchValidate() wraps in try-catch ✓

→ read_file({file_path: "src/BulkValidator.java", start_line: 28, end_line: 42})
  Result: validateAll() wraps in try-catch ✓
\`\`\`

**Decision**: All 4 callers handle the new exception. No finding — change is safely handled.
→ Move to next changed function.

### Example C: Pre-existing Issue Correctly Ignored

**Diff shows**: \`DBClient\` struct in \`db.go\` has new \`Query()\` method added.

**Investigation**:
\`\`\`
→ read_file({file_path: "src/db.go", start_line: 1, end_line: 50})
  Result: DBClient struct has a conn field but no Close() method.

→ find_usages({symbol_name: "Query", file_path: "src/db.go"})
  Result: 0 callers (newly added method)

→ think({topic: "DBClient resource management", analysis: "The struct lacks a Close() method for its conn field, but this PR only ADDS a new Query() method. The missing Close() is pre-existing — it existed before this PR. Query() itself does not open new connections or worsen the issue.", identified_risks: [], next_action: "move to next file"})
\`\`\`

**Decision**: Missing Close() is pre-existing. This PR adds Query(), which does NOT introduce or worsen the resource management issue. NOT a finding — pre-existing issues are out of scope.
→ Do NOT record. Move to next file.
</investigation_examples>`;
}
