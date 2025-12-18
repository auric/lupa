import { describe, it, expect } from "vitest";
import { ChatResponseBuilder } from "../utils/chatResponseBuilder";
import { SEVERITY, SECTION } from "../config/chatEmoji";
import type { Finding } from "../types/chatTypes";

describe("ChatResponseBuilder", () => {
    describe("addVerdictLine", () => {
        it("should render success status with checkmark emoji", () => {
            const result = new ChatResponseBuilder().addVerdictLine("success", "Looking good!").build();
            expect(result).toBe("## ✅ Looking good!\n");
        });

        it("should render issues status with search emoji", () => {
            const result = new ChatResponseBuilder().addVerdictLine("issues", "Analysis Complete").build();
            expect(result).toBe("## 🔍 Analysis Complete\n");
        });

        it("should render cancelled status with speech bubble emoji", () => {
            const result = new ChatResponseBuilder().addVerdictLine("cancelled", "Analysis paused").build();
            expect(result).toBe("## 💬 Analysis paused\n");
        });

        it("should return this for fluent chaining", () => {
            const builder = new ChatResponseBuilder();
            const returnValue = builder.addVerdictLine("success", "Test");
            expect(returnValue).toBe(builder);
        });
    });

    describe("addSummaryStats", () => {
        it("should render stats in correct format", () => {
            const result = new ChatResponseBuilder().addSummaryStats(15, 2, 3).build();
            expect(result).toBe("\n📊 **15 files** analyzed | **2** critical | **3** suggestions\n");
        });

        it("should handle zero values", () => {
            const result = new ChatResponseBuilder().addSummaryStats(0, 0, 0).build();
            expect(result).toContain("**0 files**");
            expect(result).toContain("**0** critical");
            expect(result).toContain("**0** suggestions");
        });

        it("should use SECTION.summary emoji", () => {
            const result = new ChatResponseBuilder().addSummaryStats(5, 1, 2).build();
            expect(result).toContain(SECTION.summary);
        });

        it("should use singular 'file' for count of 1", () => {
            const result = new ChatResponseBuilder().addSummaryStats(1, 0, 0).build();
            expect(result).toContain("**1 file**");
            expect(result).not.toContain("**1 files**");
        });

        it("should use plural 'files' for count other than 1", () => {
            const result = new ChatResponseBuilder().addSummaryStats(2, 0, 0).build();
            expect(result).toContain("**2 files**");

            const zeroResult = new ChatResponseBuilder().addSummaryStats(0, 0, 0).build();
            expect(zeroResult).toContain("**0 files**");
        });

        it("should return this for fluent chaining", () => {
            const builder = new ChatResponseBuilder();
            const returnValue = builder.addSummaryStats(1, 0, 0);
            expect(returnValue).toBe(builder);
        });
    });

    describe("addFindingsSection", () => {
        it("should not render section for empty findings", () => {
            const result = new ChatResponseBuilder().addFindingsSection("Critical Issues", SEVERITY.critical, []).build();
            expect(result).toBe("");
        });

        it("should render single finding in card format", () => {
            const findings: Finding[] = [
                {
                    title: "SQL Injection Risk",
                    location: "handler.ts#L45",
                    anchor: "src/auth/handler.ts#L45",
                    description: "User input not sanitized.",
                },
            ];
            const result = new ChatResponseBuilder().addFindingsSection("Critical Issues", SEVERITY.critical, findings).build();

            expect(result).toContain("### 🔴 Critical Issues");
            expect(result).toContain("**SQL Injection Risk** in [handler.ts#L45](src/auth/handler.ts#L45)");
            expect(result).toContain("User input not sanitized.");
        });

        it("should render multiple findings with blank line separation", () => {
            const findings: Finding[] = [
                { title: "Issue 1", location: "a.ts#L1", anchor: "a.ts#L1", description: "Desc 1" },
                { title: "Issue 2", location: "b.ts#L2", anchor: "b.ts#L2", description: "Desc 2" },
            ];
            const result = new ChatResponseBuilder().addFindingsSection("Issues", "🔴", findings).build();

            expect(result).toContain("**Issue 1**");
            expect(result).toContain("**Issue 2**");
            // Verify blank line separation
            expect(result).toContain("Desc 1\n\n**Issue 2**");
        });

        it("should include horizontal rule before section", () => {
            const findings: Finding[] = [{ title: "Test", location: "x.ts#L1", anchor: "x.ts#L1", description: "Test desc" }];
            const result = new ChatResponseBuilder().addFindingsSection("Test", "🔴", findings).build();

            expect(result).toContain("---");
        });

        it("should use ### heading for section title", () => {
            const findings: Finding[] = [{ title: "Test", location: "x.ts#L1", anchor: "x.ts#L1", description: "Test" }];
            const result = new ChatResponseBuilder().addFindingsSection("Section Title", "🔴", findings).build();

            expect(result).toContain("### 🔴 Section Title");
        });

        it("should return this for fluent chaining", () => {
            const builder = new ChatResponseBuilder();
            const returnValue = builder.addFindingsSection("Test", "🔴", []);
            expect(returnValue).toBe(builder);
        });
    });

    describe("addPositiveNotes", () => {
        it("should not render section for empty notes", () => {
            const result = new ChatResponseBuilder().addPositiveNotes([]).build();
            expect(result).toBe("");
        });

        it("should render single note as bullet", () => {
            const result = new ChatResponseBuilder().addPositiveNotes(["Good separation of concerns"]).build();
            expect(result).toContain("### ✅ What's Good");
            expect(result).toContain("- Good separation of concerns");
        });

        it("should render multiple notes as bullet list", () => {
            const result = new ChatResponseBuilder().addPositiveNotes(["Note 1", "Note 2", "Note 3"]).build();
            expect(result).toContain("- Note 1\n- Note 2\n- Note 3");
        });

        it("should use SEVERITY.success emoji", () => {
            const result = new ChatResponseBuilder().addPositiveNotes(["Test"]).build();
            expect(result).toContain(SEVERITY.success);
        });

        it("should include horizontal rule before section", () => {
            const result = new ChatResponseBuilder().addPositiveNotes(["Test"]).build();
            expect(result).toContain("---");
        });

        it("should return this for fluent chaining", () => {
            const builder = new ChatResponseBuilder();
            const returnValue = builder.addPositiveNotes([]);
            expect(returnValue).toBe(builder);
        });
    });

    describe("addErrorSection", () => {
        it("should render error section with warning emoji and title", () => {
            const result = new ChatResponseBuilder()
                .addErrorSection("Configuration Error", "Lupa is still initializing.")
                .build();
            expect(result).toContain("## ⚠️ Configuration Error");
            expect(result).toContain("Lupa is still initializing.");
        });

        it("should use SEVERITY.warning emoji", () => {
            const result = new ChatResponseBuilder()
                .addErrorSection("Test Error", "Message")
                .build();
            expect(result).toContain(SEVERITY.warning);
        });

        it("should not include code block when details not provided", () => {
            const result = new ChatResponseBuilder()
                .addErrorSection("Error", "Message")
                .build();
            expect(result).not.toContain("```");
        });

        it("should include code block when details provided", () => {
            const result = new ChatResponseBuilder()
                .addErrorSection("Analysis Error", "Something went wrong.", "Stack trace here")
                .build();
            expect(result).toContain("## ⚠️ Analysis Error");
            expect(result).toContain("Something went wrong.");
            expect(result).toContain("```\nStack trace here\n```");
        });

        it("should render multi-line details in code block", () => {
            const details = "Error: Connection failed\n  at Socket.connect\n  at main.ts:42";
            const result = new ChatResponseBuilder()
                .addErrorSection("Connection Error", "Failed to connect.", details)
                .build();
            expect(result).toContain("```\n" + details + "\n```");
        });

        it("should return this for fluent chaining", () => {
            const builder = new ChatResponseBuilder();
            const returnValue = builder.addErrorSection("Test", "Message");
            expect(returnValue).toBe(builder);
        });
    });

    describe("addFollowupPrompt", () => {
        it("should render with summary emoji and horizontal rule", () => {
            const result = new ChatResponseBuilder().addFollowupPrompt("Ready for review.").build();
            expect(result).toContain("---");
            expect(result).toContain("📊 Ready for review.");
        });

        it("should use SECTION.summary emoji", () => {
            const result = new ChatResponseBuilder().addFollowupPrompt("Done.").build();
            expect(result).toContain(SECTION.summary);
        });

        it("should return this for fluent chaining", () => {
            const builder = new ChatResponseBuilder();
            const returnValue = builder.addFollowupPrompt("Test");
            expect(returnValue).toBe(builder);
        });
    });

    describe("build (integration)", () => {
        it("should build complete response with all sections in correct order", () => {
            const findings: Finding[] = [{ title: "Issue", location: "x.ts#L1", anchor: "x.ts#L1", description: "Desc" }];

            const result = new ChatResponseBuilder()
                .addVerdictLine("issues", "Analysis Complete")
                .addSummaryStats(10, 1, 2)
                .addFindingsSection("Critical", SEVERITY.critical, findings)
                .addPositiveNotes(["Good work"])
                .addFollowupPrompt("Done.")
                .build();

            // Verify order: verdict first, stats second, findings, positives, prompt last
            const verdictIndex = result.indexOf("## 🔍");
            const statsIndex = result.indexOf("📊 **10 files**");
            const findingsIndex = result.indexOf("### 🔴");
            const positivesIndex = result.indexOf("### ✅ What's Good");
            const promptIndex = result.lastIndexOf("📊 Done.");

            expect(verdictIndex).toBeLessThan(statsIndex);
            expect(statsIndex).toBeLessThan(findingsIndex);
            expect(findingsIndex).toBeLessThan(positivesIndex);
            expect(positivesIndex).toBeLessThan(promptIndex);
        });

        it("should support method chaining (fluent API)", () => {
            const builder = new ChatResponseBuilder();
            const result = builder.addVerdictLine("success", "Test").addSummaryStats(1, 0, 0).build();

            expect(result).toBeTruthy();
            expect(result).toContain("✅ Test");
            expect(result).toContain("**1 file**"); // Singular
        });

        it("should build partial response when some sections omitted", () => {
            const result = new ChatResponseBuilder()
                .addVerdictLine("success", "All good!")
                .addSummaryStats(5, 0, 0)
                .addFollowupPrompt("Nothing to fix.")
                .build();

            expect(result).toContain("✅ All good!");
            expect(result).not.toContain("Critical");
            expect(result).not.toContain("What's Good");
        });

        it("should handle success flow with no issues", () => {
            const result = new ChatResponseBuilder()
                .addVerdictLine("success", "Looking good! No critical issues found.")
                .addSummaryStats(15, 0, 0)
                .addPositiveNotes(["Clean code structure", "Good error handling"])
                .addFollowupPrompt("Ready to ship!")
                .build();

            expect(result).toContain("✅ Looking good!");
            expect(result).toContain("**0** critical");
            expect(result).toContain("- Clean code structure");
            expect(result).toContain("- Good error handling");
        });

        it("should build empty string when no methods called", () => {
            const result = new ChatResponseBuilder().build();
            expect(result).toBe("");
        });
    });
});
