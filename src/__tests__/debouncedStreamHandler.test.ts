import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DebouncedStreamHandler } from "../models/debouncedStreamHandler";
import { ChatToolCallHandler } from "../types/chatTypes";

describe("DebouncedStreamHandler", () => {
    let mockInner: ChatToolCallHandler;
    let handler: DebouncedStreamHandler;

    beforeEach(() => {
        vi.useFakeTimers();
        mockInner = {
            onProgress: vi.fn(),
            onToolStart: vi.fn(),
            onToolComplete: vi.fn(),
            onFileReference: vi.fn(),
            onThinking: vi.fn(),
            onMarkdown: vi.fn(),
        };
        handler = new DebouncedStreamHandler(mockInner);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe("onProgress debouncing", () => {
        it("should pass through first call immediately", () => {
            handler.onProgress("message 1");
            expect(mockInner.onProgress).toHaveBeenCalledWith("message 1");
            expect(mockInner.onProgress).toHaveBeenCalledTimes(1);
        });

        it("should debounce rapid calls within 100ms", () => {
            handler.onProgress("message 1");
            handler.onProgress("message 2");
            handler.onProgress("message 3");

            expect(mockInner.onProgress).toHaveBeenCalledTimes(1);
            expect(mockInner.onProgress).toHaveBeenCalledWith("message 1");
        });

        it("should emit after 100ms interval", () => {
            handler.onProgress("message 1");
            expect(mockInner.onProgress).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(110);

            handler.onProgress("message 2");
            expect(mockInner.onProgress).toHaveBeenCalledTimes(2);
            expect(mockInner.onProgress).toHaveBeenLastCalledWith("message 2");
        });

        it("should store latest pending message when debounced", () => {
            handler.onProgress("message 1");
            handler.onProgress("message 2");
            handler.onProgress("message 3"); // This becomes pending

            expect(mockInner.onProgress).toHaveBeenCalledTimes(1);

            // Flush should emit the latest pending message
            handler.flush();
            expect(mockInner.onProgress).toHaveBeenCalledTimes(2);
            expect(mockInner.onProgress).toHaveBeenLastCalledWith("message 3");
        });

        it("should allow 10 updates per second with proper timing", () => {
            // First message at time 0
            handler.onProgress("message 1");
            expect(mockInner.onProgress).toHaveBeenCalledTimes(1);

            // Advance 100ms between each subsequent message
            for (let i = 2; i <= 10; i++) {
                vi.advanceTimersByTime(100);
                handler.onProgress(`message ${i}`);
            }

            expect(mockInner.onProgress).toHaveBeenCalledTimes(10);
        });
    });

    describe("flush before onToolStart", () => {
        it("should flush pending before onToolStart", () => {
            handler.onProgress("first");
            handler.onProgress("pending"); // This becomes pending
            handler.onToolStart("readFile", { path: "/test" });

            expect(mockInner.onProgress).toHaveBeenNthCalledWith(1, "first");
            expect(mockInner.onProgress).toHaveBeenNthCalledWith(2, "pending");
            expect(mockInner.onToolStart).toHaveBeenCalledWith("readFile", {
                path: "/test",
            });
        });

        it("should not flush if no pending message", () => {
            handler.onProgress("first");
            vi.clearAllMocks();

            handler.onToolStart("readFile", { path: "/test" });

            expect(mockInner.onProgress).not.toHaveBeenCalled();
            expect(mockInner.onToolStart).toHaveBeenCalledWith("readFile", {
                path: "/test",
            });
        });
    });

    describe("flush before onToolComplete", () => {
        it("should flush pending before onToolComplete", () => {
            handler.onProgress("first");
            handler.onProgress("pending");
            handler.onToolComplete("readFile", true, "done");

            expect(mockInner.onProgress).toHaveBeenCalledWith("pending");
            expect(mockInner.onToolComplete).toHaveBeenCalledWith(
                "readFile",
                true,
                "done"
            );
        });
    });

    describe("flush before onThinking", () => {
        it("should flush pending before onThinking", () => {
            handler.onProgress("first");
            handler.onProgress("pending");
            handler.onThinking("considering options...");

            expect(mockInner.onProgress).toHaveBeenCalledWith("pending");
            expect(mockInner.onThinking).toHaveBeenCalledWith("considering options...");
        });
    });

    describe("flush before onMarkdown", () => {
        it("should flush pending before onMarkdown", () => {
            handler.onProgress("first");
            handler.onProgress("pending");
            handler.onMarkdown("## Results");

            expect(mockInner.onProgress).toHaveBeenCalledWith("pending");
            expect(mockInner.onMarkdown).toHaveBeenCalledWith("## Results");
        });
    });

    describe("onFileReference pass-through", () => {
        it("should pass through onFileReference without flush", () => {
            handler.onProgress("first");
            handler.onProgress("pending"); // This becomes pending

            handler.onFileReference("/path/file.ts");

            expect(mockInner.onFileReference).toHaveBeenCalledWith(
                "/path/file.ts",
                undefined
            );
            // Should NOT have flushed the pending progress
            expect(mockInner.onProgress).toHaveBeenCalledTimes(1);
            expect(mockInner.onProgress).toHaveBeenCalledWith("first");
        });

        it("should pass through onFileReference with range", () => {
            const mockRange = { start: { line: 10 }, end: { line: 20 } };
            handler.onFileReference("/path/file.ts", mockRange as unknown as import("vscode").Range);

            expect(mockInner.onFileReference).toHaveBeenCalledWith(
                "/path/file.ts",
                mockRange
            );
        });
    });

    describe("flush() method", () => {
        it("should send pending message when called", () => {
            handler.onProgress("first");
            handler.onProgress("pending");

            vi.clearAllMocks();
            handler.flush();

            expect(mockInner.onProgress).toHaveBeenCalledWith("pending");
            expect(mockInner.onProgress).toHaveBeenCalledTimes(1);
        });

        it("should do nothing when no pending message", () => {
            handler.onProgress("message");

            vi.clearAllMocks();
            handler.flush();

            expect(mockInner.onProgress).not.toHaveBeenCalled();
        });

        it("should clear pending after flush", () => {
            handler.onProgress("first");
            handler.onProgress("pending");
            handler.flush();

            vi.clearAllMocks();
            handler.flush(); // Second flush should do nothing

            expect(mockInner.onProgress).not.toHaveBeenCalled();
        });
    });

    describe("order preservation", () => {
        it("should maintain correct order: pending → event", () => {
            const callOrder: string[] = [];

            mockInner.onProgress = vi.fn((msg) => callOrder.push(`progress:${msg}`));
            mockInner.onToolStart = vi.fn(() => callOrder.push("toolStart"));

            handler.onProgress("first");
            handler.onProgress("pending");
            handler.onToolStart("readFile", {});

            expect(callOrder).toEqual([
                "progress:first",
                "progress:pending",
                "toolStart",
            ]);
        });
    });

    describe("timing edge cases", () => {
        it("should emit exactly at 100ms boundary", () => {
            handler.onProgress("message 1");
            expect(mockInner.onProgress).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(100); // Exactly at 100ms
            handler.onProgress("message 2");
            expect(mockInner.onProgress).toHaveBeenCalledTimes(2);
        });

        it("should debounce at 99ms", () => {
            handler.onProgress("message 1");
            expect(mockInner.onProgress).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(99); // Just under 100ms
            handler.onProgress("message 2"); // Should be debounced
            expect(mockInner.onProgress).toHaveBeenCalledTimes(1);
        });

        it("should flush pending message even during debounce period", () => {
            handler.onProgress("message 1");
            handler.onProgress("message 2"); // Pending, < 100ms

            // Flush immediately without waiting
            handler.flush();

            expect(mockInner.onProgress).toHaveBeenCalledTimes(2);
            expect(mockInner.onProgress).toHaveBeenNthCalledWith(1, "message 1");
            expect(mockInner.onProgress).toHaveBeenNthCalledWith(2, "message 2");
        });
    });
});
