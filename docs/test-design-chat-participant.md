# Test Design: @lupa Chat Participant

**Date:** 2025-12-15 (Revised: 2025-12-16)
**Author:** Igor (with Murat - TEA Agent)
**Status:** Draft - Revised
**Workflow:** `.bmad/bmm/workflows/testarch/test-design`
**Mode:** Party Mode (with Sally - UX Designer input)

**Revision History:**
| Date | Version | Changes |
|------------|---------|-------------------------------------------------------------------|
| 2025-12-15 | 1.0 | Initial test design from PRD, Architecture, Epics |
| 2025-12-16 | 1.1 | Added UX Design Specification coverage (Stories 0.4, 0.5, 2.1 UX) |

---

## Executive Summary

**Scope:** Full test design for @lupa Chat Participant feature (Epics 0-3)

**Revision:** Updated December 16, 2025 to incorporate UX Design Specification requirements (Stories 0.4, 0.5, updated 2.1)

**Risk Summary:**

- Total risks identified: 16 (+4 UX-related)
- High-priority risks (≥6): 2 (R-001, R-007)
- Critical categories: TECH (10), PERF (2), BUS (2), OPS (1), UX (1)

**Coverage Summary:**

- P0 scenarios: 22 (44 hours)
- P1 scenarios: 37 (37 hours)
- P2 scenarios: 15 (7.5 hours)
- **Total effort**: 88.5 hours (~11 days)

**UX Coverage Added:**

- UX-FR-001 to UX-FR-007: Response formatting, emoji, debouncing, voice patterns
- UX-NFR-001 to UX-NFR-004: Accessibility, tone, hierarchy

---

## Risk Assessment

### High-Priority Risks (Score ≥6)

| Risk ID | Category | Description                                                     | Probability | Impact | Score | Mitigation                                                                               | Owner | Timeline  |
| ------- | -------- | --------------------------------------------------------------- | ----------- | ------ | ----- | ---------------------------------------------------------------------------------------- | ----- | --------- |
| R-001   | TECH     | ConversationRunner refactoring breaks existing command path     | 2           | 3      | **6** | Run existing tests before/after modification. Add explicit backward compatibility tests. | Dev   | Epic 0    |
| R-007   | OPS      | ServiceManager Phase 4 registration order breaks initialization | 2           | 3      | **6** | Document dependency order. Test service initialization explicitly.                       | Dev   | Story 1.1 |

### Medium-Priority Risks (Score 3-5)

| Risk ID | Category | Description                                              | Probability | Impact | Score | Mitigation                                              | Owner |
| ------- | -------- | -------------------------------------------------------- | ----------- | ------ | ----- | ------------------------------------------------------- | ----- |
| R-003   | TECH     | ChatLLMClient request.model incompatibility              | 2           | 2      | 4     | Type-safe implementation. Test with mock models.        | Dev   |
| R-004   | PERF     | First progress >500ms violates NFR-001                   | 2           | 2      | 4     | Measure time in tests. Optimize initialization path.    | QA    |
| R-006   | BUS      | Copilot not installed causes silent failure              | 2           | 2      | 4     | Test error message displayed. Log warning.              | Dev   |
| R-011   | TECH     | CancellationToken not propagated correctly               | 2           | 2      | 4     | Trace token through stack in tests.                     | Dev   |
| R-012   | DATA     | Conversation history conversion loses context            | 2           | 2      | 4     | Unit test conversion functions.                         | Dev   |
| R-013   | TECH     | DebouncedStreamHandler timing inaccurate                 | 2           | 2      | 4     | Test 100ms interval enforcement. Check for silent gaps. | Dev   |
| R-014   | BUS      | ChatResponseBuilder produces inconsistent output         | 2           | 2      | 4     | Unit test all builder methods. Test section order.      | Dev   |
| R-002   | TECH     | ILLMClient interface missing method causes runtime error | 1           | 3      | 3     | TypeScript compilation validates.                       | Dev   |

### Low-Priority Risks (Score 1-2)

| Risk ID | Category | Description                               | Probability | Impact | Score | Action  |
| ------- | -------- | ----------------------------------------- | ----------- | ------ | ----- | ------- |
| R-005   | PERF     | Streaming debounce causes UI flicker      | 2           | 1      | 2     | Monitor |
| R-008   | TECH     | Follow-up provider metadata parsing fails | 1           | 2      | 2     | Monitor |
| R-009   | TECH     | Agent Mode tool input schema mismatch     | 1           | 2      | 2     | Monitor |
| R-010   | BUS      | Disambiguation auto-routing conflicts     | 1           | 2      | 2     | Monitor |
| R-015   | TECH     | Emoji constants not imported correctly    | 1           | 2      | 2     | Monitor |
| R-016   | UX       | Progress message voice inconsistent       | 2           | 1      | 2     | Monitor |

### Risk Category Legend

- **TECH**: Technical/Architecture (flaws, integration, scalability)
- **SEC**: Security (access controls, auth, data exposure)
- **PERF**: Performance (SLA violations, degradation, resource limits)
- **DATA**: Data Integrity (loss, corruption, inconsistency)
- **BUS**: Business Impact (UX harm, logic errors, revenue)
- **OPS**: Operations (deployment, config, monitoring)

---

## Test Coverage Plan

### P0 (Critical) - Run on every commit

**Criteria**: Blocks core journey + High risk (≥6) + No workaround

| Test ID      | Requirement | Test Level  | Risk Link | Description                                                         | Owner |
| ------------ | ----------- | ----------- | --------- | ------------------------------------------------------------------- | ----- |
| 0.1-UNIT-001 | AC-0.1.1    | Unit        | R-002     | ILLMClient interface has sendRequest() method                       | Dev   |
| 0.1-UNIT-002 | AC-0.1.1    | Unit        | R-002     | ILLMClient interface has getCurrentModel() method                   | Dev   |
| 0.1-UNIT-003 | AC-0.1.2    | Unit        | R-001     | ModelRequestHandler.sendRequest() converts messages correctly       | Dev   |
| 0.2-UNIT-001 | AC-0.2.1    | Unit        | R-001     | CopilotModelManager implements ILLMClient                           | Dev   |
| 0.2-UNIT-002 | AC-0.2.2    | Unit        | R-001     | CopilotModelManager backward compatibility                          | Dev   |
| 0.2-INT-001  | AC-0.2.2    | Integration | R-001     | ToolCallingAnalysisProvider works with modified CopilotModelManager | QA    |
| 0.3-UNIT-001 | AC-0.3.1    | Unit        | R-001     | ConversationRunner accepts ILLMClient in constructor                | Dev   |
| 0.3-UNIT-002 | AC-0.3.2    | Unit        | R-001     | ConversationRunner existing tests pass unchanged                    | Dev   |
| 0.3-INT-001  | AC-0.3.3    | Integration | R-001     | Full conversation loop works with CopilotModelManager               | QA    |
| 0.4-UNIT-001 | AC-0.4.1    | Unit        | R-015     | SEVERITY emoji constants defined (🔴🟡✅⚠️)                         | Dev   |
| 0.4-UNIT-002 | AC-0.4.1    | Unit        | R-015     | ACTIVITY emoji constants defined (💭🔍📂🔎)                         | Dev   |
| 0.4-UNIT-003 | AC-0.4.2    | Unit        | R-013     | DebouncedStreamHandler limits onProgress to max 10/sec              | Dev   |
| 0.4-UNIT-004 | AC-0.4.2    | Unit        | R-013     | DebouncedStreamHandler flushes pending before onToolStart           | Dev   |
| 0.5-UNIT-001 | AC-0.5.1    | Unit        | R-014     | addVerdictLine renders ✅/🔍/💬 for success/issues/cancelled        | Dev   |
| 0.5-UNIT-002 | AC-0.5.1    | Unit        | R-014     | addSummaryStats formats "X files, Y critical, Z suggestions"        | Dev   |
| 0.5-UNIT-003 | AC-0.5.2    | Unit        | R-014     | addFindingsSection creates **Title** in [location](anchor) format   | Dev   |
| 1.1-UNIT-001 | FR-001      | Unit        | -         | Chat participant registered with correct ID                         | Dev   |
| 1.1-UNIT-002 | FR-002      | Unit        | -         | Participant declares /branch and /changes commands                  | Dev   |
| 1.2-UNIT-001 | AC-1.2.1    | Unit        | R-003     | ChatLLMClient wraps request.model correctly                         | Dev   |
| 1.2-UNIT-002 | AC-1.2.1    | Unit        | R-003     | ChatLLMClient.sendRequest() delegates to ModelRequestHandler        | Dev   |
| 1.2-INT-001  | AC-1.2.2    | Integration | R-001     | /branch command creates ChatLLMClient and ConversationRunner        | QA    |
| 1.4-INT-001  | AC-1.4.1    | Integration | R-011     | CancellationToken propagated to ConversationRunner                  | QA    |

**Total P0**: 22 tests, 44 hours

### P1 (High) - Run on PR to main

**Criteria**: Important features + Medium risk (3-4) + Common workflows

| Test ID      | Requirement | Test Level  | Risk Link | Description                                           | Owner |
| ------------ | ----------- | ----------- | --------- | ----------------------------------------------------- | ----- |
| 0.1-UNIT-004 | AC-0.1.2    | Unit        | R-001     | ModelRequestHandler handles timeout                   | Dev   |
| 0.1-UNIT-005 | AC-0.1.2    | Unit        | R-001     | ModelRequestHandler parses tool calls                 | Dev   |
| 0.1-UNIT-006 | AC-0.1.2    | Unit        | -         | ModelRequestHandler propagates errors                 | Dev   |
| 0.4-UNIT-005 | AC-0.4.1    | Unit        | R-015     | SECTION emoji constants defined (🔒🧪📊📁)            | Dev   |
| 0.4-UNIT-006 | AC-0.4.2    | Unit        | R-013     | DebouncedStreamHandler passes through onMarkdown      | Dev   |
| 0.4-UNIT-007 | AC-0.4.3    | Unit        | R-013     | DebouncedStreamHandler.flush() sends pending message  | Dev   |
| 0.4-UNIT-008 | AC-0.4.1    | Unit        | R-015     | Types exported (SeverityType, ActivityType)           | Dev   |
| 0.4-UNIT-009 | AC-0.4.2    | Unit        | R-013     | No silent gaps >2 seconds during active analysis      | Dev   |
| 0.5-UNIT-004 | AC-0.5.3    | Unit        | R-014     | addPositiveNotes creates "What's Good" section        | Dev   |
| 0.5-UNIT-005 | AC-0.5.1    | Unit        | R-014     | addFollowupPrompt adds summary line                   | Dev   |
| 0.5-UNIT-006 | AC-0.5.4    | Unit        | R-014     | build() concatenates all sections correctly           | Dev   |
| 0.5-UNIT-007 | AC-0.5.1    | Unit        | R-015     | Builder uses emoji from chatEmoji.ts constants        | Dev   |
| 0.5-UNIT-008 | AC-0.5.2    | Unit        | R-014     | Finding cards use **Title** in [location](anchor)     | Dev   |
| 0.5-UNIT-009 | AC-0.5.3    | Unit        | R-014     | Positive notes appear AFTER findings section          | Dev   |
| 1.1-UNIT-003 | FR-003      | Unit        | -         | Participant has isSticky: true                        | Dev   |
| 1.1-UNIT-004 | NFR-031     | Unit        | R-006     | Graceful degradation if Copilot not installed         | Dev   |
| 1.1-INT-001  | AC-1.1.4    | Integration | R-007     | ChatParticipantService in ServiceManager Phase 4      | QA    |
| 1.2-UNIT-003 | AC-1.2.1    | Unit        | R-003     | ChatLLMClient.getCurrentModel() returns wrapped model | Dev   |
| 1.2-INT-002  | AC-1.2.2    | Integration | -         | /branch calls GitOperations.getDiffToDefaultBranch()  | QA    |
| 1.2-INT-003  | AC-1.2.3    | Integration | R-004     | stream.progress() called within 500ms                 | QA    |
| 1.2-INT-004  | AC-1.2.3    | Integration | -         | stream.markdown() called with results                 | QA    |
| 1.2-INT-005  | AC-1.2.4    | Integration | -         | Error returns ChatResult.errorDetails                 | QA    |
| 1.3-INT-001  | FR-011      | Integration | -         | /changes calls getUncommittedDiff()                   | QA    |
| 1.3-INT-002  | AC-1.3.2    | Integration | -         | Progress indicates "uncommitted changes"              | QA    |
| 1.4-INT-002  | AC-1.4.2    | Integration | R-011     | Cancellation streams "Analysis cancelled"             | QA    |
| 2.1-UNIT-001 | AC-2.1.1    | Unit        | -         | ToolCallHandler interface complete                    | Dev   |
| 2.1-UNIT-002 | AC-2.1.3    | Unit        | R-005     | Debounce limits updates to 10/second                  | Dev   |
| 2.1-UNIT-003 | UX-FR-004   | Unit        | R-016     | Progress messages use ACTIVITY emoji (📂🔍💭)         | Dev   |
| 2.1-UNIT-004 | UX-FR-001   | Unit        | R-014     | ChatStreamHandler uses ChatResponseBuilder            | Dev   |
| 2.1-INT-001  | AC-2.1.2    | Integration | -         | stream.anchor() for file:line                         | QA    |
| 2.1-INT-004  | UX-FR-007   | Integration | R-014     | Empty state uses positive framing "✅ Looking good!"  | QA    |
| 2.2-UNIT-001 | FR-030      | Unit        | -         | ChatFollowupProvider implemented                      | Dev   |
| 2.2-UNIT-002 | AC-2.2.2    | Unit        | -         | Follow-ups contextual on hasCriticalIssues            | Dev   |
| 2.3-UNIT-001 | FR-050      | Unit        | R-009     | lupa_getSymbolsOverview registered                    | Dev   |
| 2.3-UNIT-002 | FR-052      | Unit        | R-009     | Tool wraps GetSymbolsOverviewTool                     | Dev   |
| 2.3-INT-001  | AC-2.3.3    | Integration | R-009     | Tool returns correct result format                    | QA    |
| 2.3-INT-002  | AC-2.3.4    | Integration | R-007     | LanguageModelToolProvider in Phase 4                  | QA    |

**Total P1**: 37 tests, 37 hours

### P2 (Medium) - Run nightly/weekly

**Criteria**: Secondary features + Low risk (1-2) + Edge cases

| Test ID      | Requirement | Test Level  | Risk Link | Description                                    | Owner |
| ------------ | ----------- | ----------- | --------- | ---------------------------------------------- | ----- |
| 1.3-INT-003  | AC-1.3.3    | Integration | -         | Empty diff returns helpful message             | QA    |
| 1.4-INT-003  | AC-1.4.3    | Integration | -         | Partial results visible after cancellation     | QA    |
| 2.1-INT-002  | AC-2.1.2    | Integration | -         | stream.reference() for file-only               | QA    |
| 2.1-INT-003  | AC-2.1.4    | Integration | -         | stream.filetree() for changed files            | QA    |
| 2.1-UNIT-005 | UX-FR-004   | Unit        | R-016     | Progress voice follows "📂 Reading..." pattern | Dev   |
| 2.1-INT-005  | UX-FR-005   | Integration | R-014     | Finding cards render with anchors              | QA    |
| 2.2-UNIT-003 | AC-2.2.2    | Unit        | -         | "What tests should I add?" always available    | Dev   |
| 2.2-INT-001  | AC-2.2.3    | Integration | -         | Follow-up click continues conversation         | QA    |
| 3.1-INT-001  | FR-012      | Integration | -         | No-command routes to exploration               | QA    |
| 3.1-INT-002  | AC-3.1.2    | Integration | -         | Exploration uses tools for context             | QA    |
| 3.1-INT-003  | AC-3.1.3    | Integration | -         | Responses reference workspace code             | QA    |
| 3.2-INT-001  | AC-3.2.1    | Integration | R-012     | History extracted from ChatContext             | QA    |
| 3.2-INT-002  | AC-3.2.2    | Integration | R-012     | ChatRequestTurn conversion                     | QA    |
| 3.3-UNIT-001 | FR-004      | Unit        | R-010     | Disambiguation in package.json                 | Dev   |
| 3.3-INT-001  | AC-3.3.3    | Integration | R-010     | isParticipantDetected handled                  | QA    |

**Total P2**: 15 tests, 7.5 hours

---

## Execution Order

### Smoke Tests (<5 min)

**Purpose**: Fast feedback, catch build-breaking issues

- [ ] 0.3-UNIT-002: ConversationRunner existing tests pass (30s)
- [ ] 0.4-UNIT-001: SEVERITY emoji constants defined (15s)
- [ ] 0.4-UNIT-003: DebouncedStreamHandler limits 10/sec (30s)
- [ ] 0.5-UNIT-001: addVerdictLine renders correct emoji (15s)
- [ ] 1.1-UNIT-001: Chat participant registered (15s)
- [ ] 1.2-UNIT-001: ChatLLMClient wraps model (15s)
- [ ] 2.3-UNIT-001: Agent Mode tool registered (15s)

**Total**: 7 scenarios, <3 min

### P0 Tests (<15 min)

**Purpose**: Critical path validation

- [ ] All Epic 0 tests (interface compliance, backward compatibility)
- [ ] Story 0.4 tests (emoji constants, DebouncedStreamHandler)
- [ ] Story 0.5 tests (ChatResponseBuilder core methods)
- [ ] Core chat participant registration
- [ ] ChatLLMClient implementation
- [ ] Cancellation token propagation

**Total**: 22 scenarios

### P1 Tests (<45 min)

**Purpose**: Important feature coverage

- [ ] Streaming behavior (progress, markdown)
- [ ] Performance validation (500ms first response)
- [ ] UX patterns (emoji usage, response builder integration)
- [ ] Follow-up provider
- [ ] Agent Mode tool execution
- [ ] Exploration mode
- [ ] History conversion

**Total**: 37 scenarios

### P2 Tests (<60 min)

**Purpose**: Full regression coverage

- [ ] Edge cases (empty diff, partial results)
- [ ] Rich UX (filetree, references, finding cards)
- [ ] Progress voice patterns
- [ ] Exploration and history
- [ ] Disambiguation

**Total**: 15 scenarios

---

## Resource Estimates

### Test Development Effort

| Priority  | Count  | Hours/Test | Total Hours | Notes                                          |
| --------- | ------ | ---------- | ----------- | ---------------------------------------------- |
| P0        | 22     | 2.0        | 44          | Complex setup, backward compatibility, UX core |
| P1        | 37     | 1.0        | 37          | Standard coverage + UX patterns                |
| P2        | 15     | 0.5        | 7.5         | Edge cases, exploration                        |
| **Total** | **74** | **-**      | **88.5**    | **~11 days**                                   |

### Prerequisites

**Test Data:**

- Mock `LanguageModelChat` (VS Code API mock)
- Mock `ChatRequest` with commands
- Mock `ChatResponseStream` for assertions
- Git repository fixtures for diff operations
- Mock `ToolCallHandler` for DebouncedStreamHandler testing

**Tooling:**

- Vitest (existing)
- vscode.js mock (existing, extend for chat API)
- GitOperations mock (existing)
- Timing utilities for debounce testing

**Environment:**

- Vitest with VS Code mock (existing infrastructure)
- No real VS Code instance needed for unit/integration

---

## Quality Gate Criteria

### Pass/Fail Thresholds

- **P0 pass rate**: 100% (no exceptions)
- **P1 pass rate**: ≥95% (waivers required for failures)
- **P2 pass rate**: ≥90% (informational)
- **High-risk mitigations**: 100% complete or approved waivers

### Coverage Targets

- **Critical paths**: ≥80% (Epic 0 + Core chat participant)
- **Interface compliance**: 100% (ILLMClient, ToolCallHandler)
- **Backward compatibility**: 100% (existing ConversationRunner tests)
- **UX components**: 100% (ChatResponseBuilder, DebouncedStreamHandler, chatEmoji)
- **Edge cases**: ≥50%

### Non-Negotiable Requirements

- [ ] All P0 tests pass
- [ ] No high-risk (≥6) items unmitigated
- [ ] Existing tests pass (backward compatibility)
- [ ] Performance targets met (NFR-001: <500ms first progress)
- [ ] UX components fully tested (emoji, builder, debounce)

---

## Mitigation Plans

### R-001: ConversationRunner refactoring breaks existing command path (Score: 6)

**Mitigation Strategy:**

1. Before any changes: Run `npx vitest run src/__tests__/conversationRunner.test.ts`
2. After ILLMClient change: Same test must pass unchanged
3. Add explicit backward compatibility test in Story 0.3
4. Code review focuses on constructor signature

**Owner:** Dev
**Timeline:** Epic 0 completion
**Status:** Planned
**Verification:** Existing test suite passes, new compatibility test passes

### R-007: ServiceManager Phase 4 registration order breaks initialization (Score: 6)

**Mitigation Strategy:**

1. Document ChatParticipantService dependencies explicitly
2. Add initialization order test in Story 1.1
3. Follow existing Phase 4 patterns (ContextProvider, AnalysisProvider)
4. Test service can be retrieved after initialization

**Owner:** Dev
**Timeline:** Story 1.1 completion
**Status:** Planned
**Verification:** ServiceManager.getChatParticipantService() returns valid instance

---

## Assumptions and Dependencies

### Assumptions

1. VS Code Chat Participant API remains stable (no breaking changes in 1.95+)
2. Existing `vscode.js` mock can be extended for chat API
3. `GitOperations` mocks are sufficient for diff-related tests
4. `request.model` behavior matches documentation

### Dependencies

1. Epic 0 must complete before Epic 1 (ILLMClient required)
2. Story 1.1 must complete before Stories 1.2-1.4 (service registration)
3. Story 1.2 must complete before Stories 2.1-2.2 (streaming infrastructure)

### Risks to Plan

- **Risk**: VS Code API changes in future versions
  - **Impact**: Tests may need updates
  - **Contingency**: Pin to VS Code 1.95, monitor release notes

---

## Test File Structure

```
src/__tests__/
├── chatEmoji.test.ts                  # Story 0.4: Emoji constant tests
├── chatLLMClient.test.ts              # Story 1.2: ChatLLMClient unit tests
├── chatParticipantService.test.ts     # Stories 1.1-1.4, 3.1-3.3: Service tests
├── chatResponseBuilder.test.ts        # Story 0.5: Response builder tests
├── chatStreamHandler.test.ts          # Story 2.1: Stream handler + UX patterns
├── conversationRunner.test.ts         # Story 0.3: Backward compatibility (existing)
├── debouncedStreamHandler.test.ts     # Story 0.4: Debounce timing tests
├── ILLMClient.test.ts                 # Story 0.1: Interface tests
├── languageModelToolProvider.test.ts  # Story 2.3: Agent Mode tool tests
├── modelRequestHandler.test.ts        # Story 0.1: Message conversion tests
└── toolCallHandler.test.ts            # Story 2.1: Handler interface tests
```

---

## UX Requirements Coverage Map

| UX Requirement | Description                                     | Test IDs                                 | Status  |
| -------------- | ----------------------------------------------- | ---------------------------------------- | ------- |
| UX-FR-001      | ChatResponseBuilder response structure          | 0.5-UNIT-001 to 0.5-UNIT-009             | Covered |
| UX-FR-002      | Emoji constants centralized in chatEmoji.ts     | 0.4-UNIT-001, 0.4-UNIT-002, 0.4-UNIT-005 | Covered |
| UX-FR-003      | DebouncedStreamHandler limits to 10 updates/sec | 0.4-UNIT-003, 0.4-UNIT-004, 0.4-UNIT-009 | Covered |
| UX-FR-004      | Progress message voice pattern                  | 2.1-UNIT-003, 2.1-UNIT-005               | Covered |
| UX-FR-005      | Finding card format **Title** in [location]     | 0.5-UNIT-003, 0.5-UNIT-008, 2.1-INT-005  | Covered |
| UX-FR-006      | "What's Good" section in responses              | 0.5-UNIT-004, 0.5-UNIT-009               | Covered |
| UX-FR-007      | Empty states use positive framing               | 2.1-INT-004                              | Covered |
| UX-NFR-001     | Emoji distinguishable by shape (accessibility)  | 0.4-UNIT-001, 0.4-UNIT-002               | Covered |
| UX-NFR-002     | Link text descriptive                           | 2.1-INT-005                              | Covered |
| UX-NFR-003     | Heading hierarchy logical                       | 0.5-UNIT-006                             | Covered |
| UX-NFR-004     | Tone supportive, non-judgmental                 | 0.5-UNIT-004, 2.1-INT-004                | Covered |

---

## Approval

**Test Design Approved By:**

- [ ] Product Manager: Date:
- [ ] Tech Lead: Date:
- [ ] QA Lead: Date:

**Comments:**

---

## Appendix

### Knowledge Base References

- `risk-governance.md` - Risk classification framework
- `probability-impact.md` - Risk scoring methodology
- `test-levels-framework.md` - Test level selection
- `test-priorities-matrix.md` - P0-P3 prioritization

### Related Documents

- PRD: [docs/prd.md](prd.md)
- Architecture: [docs/architecture.md](architecture.md) (v1.1 with UX revisions)
- Epics: [docs/epics.md](epics.md) (revised with Stories 0.4, 0.5)
- UX Design: [docs/ux-design-specification.md](ux-design-specification.md)

---

**Generated by**: BMad TEA Agent - Test Architect Module
**Workflow**: `.bmad/bmm/workflows/testarch/test-design`
**Version**: 4.0 (BMad v6)
**Mode**: Party Mode
**Revision**: 1.1 (December 16, 2025)
**UX Input**: Sally (UX Designer) - emotional design validation
