# Research Prompt: GPT-4.1 Investigation Depth & RLM Approach

> **Instructions**: Paste this entire prompt into a NEW chat session. Select Claude Opus 4.6 as the model. The agent should use sequential thinking (in subagents) and subagent delegation for research.

---

## Context

**Lupa** is a VS Code extension for PR code review using GitHub Copilot models. It uses a **Recursive Language Model (RLM)** approach — an iterative, tool-calling architecture where the LLM dynamically composes its own analysis pipeline via tool calls.

### The Problem: GPT-4.1 Finds Fewer Issues

When reviewing PRs:

- **GPT-4o** finds more potential issues per review
- **GPT-4.1** finds noticeably fewer issues, often stops early
- **Claude models** find the most issues
- **All models** have very high false positive rates

This matters because GPT-4.1 is the **default model** for many Copilot users, and the extension needs to provide value across all supported models.

### Known GPT-4.1 Characteristics (From Research)

1. **Aider Benchmark**: GPT-4.1 scored **52.4%** vs Claude 3.7 Sonnet at 64.9%, Gemini 2.5 Pro at 72.9%
2. **Tool calling behavior**: GPT-4.1 is conservative — calls fewer tools per turn
3. **Complexity handling**: "Can handle significantly less complexity than Claude"
4. **Task focus**: Performs best with simple, focused, well-defined tasks
5. **Early stopping**: Tends to "stop quickly to ask questions" or settle on first finding
6. **Instruction following**: Very good at following explicit instructions, but needs more structure

### Current Architecture (RLM Approach)

Each analysis involves:

1. **Root Agent**: Reads PR description, decomposes into investigation tasks
2. **Subagents**: Each assigned 1-2 files + investigation area, runs independently
3. **Each Subagent Loop**:
    - Reads assigned files via `read_file` tool
    - Uses `find_symbol`, `find_usages`, `search_for_pattern` to investigate
    - Uses `get_file_diff` to understand what changed
    - Records findings via `record_finding` tool
    - Can retract findings via `retract_finding`
    - Has `think` tool for scratchpad reasoning
    - Has `validate_claim` for LSP-based verification

### How Our RLM Architecture Works

From `src/models/conversationRunner.ts`:

```typescript
async run(conversation: RecordedConversation, options: ConversationRunnerOptions): Promise<string | undefined> {
    let iteration = 0;
    while (iteration < maxIterations) {
        const response = await this.sendRequest(conversation, tools, ...);

        if (response.finishReason === 'stop') {
            // Model decided it's done - return final message
            return response.content;
        }

        if (response.finishReason === 'tool_calls') {
            // Execute tools, add results, continue loop
            for (const toolCall of response.toolCalls) {
                const result = await tool.execute(toolCall.parameters, context);
                conversation.addToolResult(toolCall.id, result);
            }
        }
        iteration++;
    }
}
```

From `src/services/toolCallingAnalysisProvider.ts`:

- Root agent gets: PR description, changed files list, diff overview
- Each subagent gets: assigned files list, investigation context from root agent
- `maxIterations = 50 (root) / 30 (subagent)` — but GPT-4.1 often stops at 5-8 iterations

### Relevant Prompt Structure

From `src/prompts/subagentPromptGenerator.ts`:

- Models receive investigation instructions
- Finding quality guidance is appended (from `findingQualityGuidance.ts`)
- Category taxonomy constrains finding types
- Self-disproof requirement forces models to attempt falsification

### Model Calibration System

From `src/models/modelCalibration.ts`:

```typescript
interface ModelProfile {
    displayName: string;
    maxTokens: number;
    temperature: number;
    promptStyle: PromptStyle;
    adversarialVerificationThreshold: SeverityLevel;
    includeEvidenceGuidance: boolean;
    includeFalsePositiveGuide: boolean;
    includeQualityExamplePrompts: boolean;
    rootMaxIterations: number;
    subagentMaxIterations: number;
}
```

GPT-4.1 currently has `includeFalsePositiveGuide: false` because it becomes too dismissive with FP guidance (finds 0 issues).

## Research Task

### Phase 1: Deep Research on GPT-4.1 Optimization

Run internet searches for:

1. **Tavily**: "GPT-4.1 tool calling optimization best practices 2025"
2. **Tavily**: "GPT-4.1 system prompt instruction following tricks"
3. **Tavily**: "recursive language model iterative tool use agent optimization"
4. **Tavily**: "GPT-4.1 vs Claude code review LLM comparison agentic"
5. **Tavily**: "agentic coding GPT-4.1 prompt engineering investigation depth"

### Phase 2: Research the Codebase

Read these files to understand current behavior:

1. `src/models/modelCalibration.ts` — Current GPT-4.1 profile settings
2. `src/models/conversationRunner.ts` — The main loop, `beforeAcceptingResponse` hook
3. `src/prompts/subagentPromptGenerator.ts` — How subagent prompts are constructed
4. `src/prompts/blocks/findingQualityGuidance.ts` — Current quality guidance
5. `src/prompts/rootAgentPromptGenerator.ts` — How root agent plans decomposition
6. `src/services/toolCallingAnalysisProvider.ts` — Subagent spawning logic
7. `src/tools/recordFindingTool.ts` — The schema models must conform to

### Phase 3: Analyze the "Early Stopping" Problem (Use Sequential Thinking)

**Hypothesis 1: GPT-4.1 hits `finishReason: 'stop'` too early**

- The model generates a summary and stops after 5-8 tool calls
- It doesn't think "I should investigate more"
- Fix: Use `beforeAcceptingResponse` callback to check if enough investigation was done
- Check: Was `validate_claim` called? Was `find_usages` called? Did it use `get_file_diff`?

**Hypothesis 2: GPT-4.1 needs MORE structure in investigation flow**

- Instead of "investigate these files for bugs", give explicit investigation steps:
    1. "First, read each assigned file completely"
    2. "Then, get the diff for each file"
    3. "For each changed function, find all callers using find_usages"
    4. "For each type used, verify type compatibility using validate_claim"
    5. "Now analyze your investigation data for bugs"
- This matches research finding that GPT-4.1 needs "simple, focused tasks"

**Hypothesis 3: GPT-4.1 needs per-model prompt engineering**

- Different models respond differently to prompts
- GPT-4.1 may need:
    - More assertive language ("You MUST call at least 5 tools before recording findings")
    - Explicit enumeration of investigation steps
    - Structured output templates
    - Higher `maxIterations` encouragement in prompt

**Hypothesis 4: GPT-4.1 should get DIFFERENT tasks than other models**

- Instead of "analyze files X and Y for bugs", give GPT-4.1:
    - "Check if function X handles null input correctly" (yes/no)
    - "Verify error handling in function Y covers all error types" (specific task)
    - "Does the new code in file Z maintain backward compatibility?" (focused question)
- Each task is binary/focused, matching GPT-4.1's strength profile

**Hypothesis 5: The RLM loop needs model-specific iteration nudging**

- `beforeAcceptingResponse` can check investigation depth:

    ```typescript
    beforeAcceptingResponse: (response, conversation) => {
        const toolCallCount = conversation.toolCalls.length;
        const uniqueToolsUsed = new Set(
            conversation.toolCalls.map((tc) => tc.name)
        );

        if (toolCallCount < 5 && !uniqueToolsUsed.has('validate_claim')) {
            // Nudge the model to investigate more
            return {
                accept: false,
                nudgeMessage:
                    'You stopped too early. Use validate_claim and find_usages before concluding.',
            };
        }
        return { accept: true };
    };
    ```

### Phase 4: Design Investigation Depth Protocol

Design a model-calibrated investigation protocol:

1. **Minimum investigation requirements** (per model profile):
    - Min tool calls before first `record_finding`
    - Required tools that MUST be called (e.g., `get_file_diff`, `find_usages`)
    - Min unique files read before accepting response

2. **Investigation templates** (for GPT-4.1):
    - Step-by-step investigation flow embedded in prompt
    - Each step names the tool to use and what to look for
    - Template varies by investigation type (security, logic, etc.)

3. **Model-specific decomposition strategy**:
    - GPT-4.1: More subagents, each with 1 file + 1 focused question
    - GPT-4o: Moderate subagents, 2-3 files + broader investigation
    - Claude: Fewer subagents, more files, open-ended investigation

4. **Adaptive iteration nudging**:
    - Track investigation quality signals
    - If model stops early, inject nudge message
    - Different nudge strategies per model

### Phase 5: Implementation

Implement the investigation depth improvements:

1. **Update `ModelProfile`** with investigation depth settings:
    - `minToolCallsBeforeRecording: number`
    - `requiredToolTypes: string[]` (tools that must be called before stopping)
    - `investigationTemplate: string | null` (model-specific investigation steps)
    - `taskDecompositionGranularity: 'coarse' | 'medium' | 'fine'`

2. **Implement investigation depth checking**:
    - In `conversationRunner.ts`: track tool calls per type
    - In `beforeAcceptingResponse`: check depth requirements
    - Nudge messages specific to what's missing

3. **Update prompt generation**:
    - Per-model investigation templates
    - GPT-4.1 gets structured step-by-step instructions
    - Other models get open-ended investigation guidance

4. **Update task decomposition**:
    - Root agent prompt varies by model's `taskDecompositionGranularity`
    - GPT-4.1 gets fine-grained tasks (1 file, 1 question)
    - Claude gets coarse-grained tasks (multiple files, open investigation)

5. **Tests**:
    - Test investigation depth checking logic
    - Test nudge message generation
    - Test model-specific prompt generation
    - Test task decomposition granularity

## Constraints

- Follow all conventions in CLAUDE.md and ARCHITECTURE.md
- Run `npm run check-types` after changes
- All changes must be backward compatible
- Must not break existing tests
- Model profiles are in `src/models/modelCalibration.ts`
- The `beforeAcceptingResponse` callback already exists in the conversation runner

## Expected Output

1. **Root cause analysis** of why GPT-4.1 finds fewer issues
2. **Investigation depth protocol** with model-specific settings
3. **Prompt changes** for GPT-4.1 vs other models
4. **Implementation** across affected files
5. **Test coverage** for new behavior
6. **Benchmark comparison plan** to measure improvement
