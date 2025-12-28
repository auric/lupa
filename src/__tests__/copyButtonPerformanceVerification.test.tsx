import { render, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { MarkdownRenderer } from '../webview/components/MarkdownRenderer';
import { useCopyToClipboard } from '../webview/hooks/useCopyToClipboard';

// Mock the path utilities and VS Code API
vi.mock('../lib/pathUtils', () => ({
    parseFilePaths: vi.fn(() => [])
}));

vi.mock('../webview/hooks/useVSCodeApi', () => ({
    useVSCodeApi: () => null
}));

// Test component that creates MANY copy buttons to verify performance
const ManyButtonsTest: React.FC = () => {
    const copyToClipboard = useCopyToClipboard();

    // Create content with many code blocks to simulate real usage
    const createContentWithManyCodeBlocks = () => {
        const blocks = Array.from({ length: 20 }, (_, i) => {
            return `\`\`\`javascript
function test${i}() {
    console.log("Code block ${i}");
    return ${i} * 2;
}
\`\`\``;
        }).join('\n\n');

        return `# Test Content with Many Code Blocks\n\n${blocks}`;
    };

    return (
        <div data-testid="many-buttons-container">
            {/* Create multiple MarkdownRenderers each with many code blocks */}
            {Array.from({ length: 5 }, (_, rendererIndex) => (
                <div key={rendererIndex} data-testid={`renderer-${rendererIndex}`}>
                    <h2>Renderer {rendererIndex}</h2>
                    <MarkdownRenderer
                        content={createContentWithManyCodeBlocks()}
                        id={`renderer-${rendererIndex}`}
                        isDarkTheme={false}
                        onCopy={copyToClipboard}
                    />
                </div>
            ))}
        </div>
    );
};

describe('Copy Button Performance Verification', () => {
    beforeEach(() => {
        vi.clearAllMocks();

        // Mock clipboard API
        Object.assign(navigator, {
            clipboard: {
                writeText: vi.fn().mockResolvedValue(void 0),
            },
        });
    });

    it('should handle many copy buttons without performance issues', () => {
        const startTime = performance.now();

        render(<ManyButtonsTest />);

        const renderTime = performance.now() - startTime;

        // Should render many buttons quickly (under 1 second)
        expect(renderTime).toBeLessThan(1000);

        // Should have many copy buttons (5 renderers * 21 buttons each = 105 total)
        // 20 code blocks + 1 main copy button per renderer = 21 per renderer
        const copyButtons = document.querySelectorAll('button[title*="Copy"]');
        expect(copyButtons.length).toBe(105);
    });

    it('should handle rapid clicks on many buttons without delays', async () => {
        render(<ManyButtonsTest />);

        // Get first 10 copy buttons for testing
        const copyButtons = Array.from(document.querySelectorAll('button[title*="Copy"]')).slice(0, 10);

        const startTime = performance.now();

        // Click all buttons rapidly
        await act(async () => {
            copyButtons.forEach(button => {
                fireEvent.click(button);
            });
        });

        const clickTime = performance.now() - startTime;

        // Should handle 10 rapid clicks very quickly (under 200ms)
        expect(clickTime).toBeLessThan(200);

        // Should have called clipboard API for each click
        expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(10);
    });

    it('should not cause cascade re-renders when buttons are clicked', () => {
        let renderCount = 0;

        // Create a component that tracks renders
        const RenderTracker: React.FC<{ children: React.ReactNode }> = ({ children }) => {
            renderCount++;
            return <div data-testid="render-tracker">{children}</div>;
        };

        const WrappedTest: React.FC = () => {
            const copyToClipboard = useCopyToClipboard();

            return (
                <RenderTracker>
                    <div data-testid="wrapped-container">
                        <MarkdownRenderer
                            content="# Test\n\n```js\ntest code 1\n```\n\n```js\ntest code 2\n```"
                            id="test-renderer-1"
                            isDarkTheme={false}
                            onCopy={copyToClipboard}
                        />
                        <MarkdownRenderer
                            content="# Test 2\n\n```js\ntest code 3\n```\n\n```js\ntest code 4\n```"
                            id="test-renderer-2"
                            isDarkTheme={false}
                            onCopy={copyToClipboard}
                        />
                    </div>
                </RenderTracker>
            );
        };

        render(<WrappedTest />);

        const initialRenderCount = renderCount;

        // Click the first copy button
        const firstButton = document.querySelector('button[title*="Copy"]');
        fireEvent.click(firstButton!);

        // Should not cause any additional renders of the parent components
        // Only the individual CopyButton should re-render internally
        expect(renderCount - initialRenderCount).toBe(0);
    });

    it('should maintain button states independently', async () => {
        render(<ManyButtonsTest />);

        // Get first 3 copy buttons
        const buttons = Array.from(document.querySelectorAll('button[title*="Copy"]')).slice(0, 3);

        // Click first button
        fireEvent.click(buttons[0]!);

        // First button should show "Copied!" while others show "Copy to clipboard"
        expect(buttons[0]!.getAttribute('title')).toBe('Copied!');
        expect(buttons[1]!.getAttribute('title')).toBe('Copy to clipboard');
        expect(buttons[2]!.getAttribute('title')).toBe('Copy to clipboard');

        // Click second button
        fireEvent.click(buttons[1]!);

        // Now first and second should show "Copied!"
        expect(buttons[0]!.getAttribute('title')).toBe('Copied!');
        expect(buttons[1]!.getAttribute('title')).toBe('Copied!');
        expect(buttons[2]!.getAttribute('title')).toBe('Copy to clipboard');
    });
});