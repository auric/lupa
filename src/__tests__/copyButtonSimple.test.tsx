import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { MarkdownRenderer } from '../webview/components/MarkdownRenderer';
import { useCopyToClipboard } from '../webview/hooks/useCopyToClipboard';

// Mock the path utilities and VS Code API
vi.mock('../lib/pathUtils', () => ({
    parseFilePaths: vi.fn(() => []),
}));

vi.mock('../webview/hooks/useVSCodeApi', () => ({
    useVSCodeApi: () => null,
}));

// Test component with multiple markdown renderers
const TestMultipleRenderers: React.FC = () => {
    const copyToClipboard = useCopyToClipboard();
    const [copyCount, setCopyCount] = React.useState(0);

    // Create content with code blocks
    const createContentWithCodeBlocks = (index: number) => {
        return `# Renderer ${index}

Some text content here.

\`\`\`javascript
function test${index}() {
    console.log("Test ${index}");
    return ${index};
}
\`\`\`

More content here.

\`\`\`python
def test${index}():
    print("Test ${index}")
    return ${index}
\`\`\`
`;
    };

    const handleCopy = (text: string) => {
        copyToClipboard(text);
        setCopyCount((prev) => prev + 1);
    };

    return (
        <div data-testid="test-container">
            <div data-testid="copied-states-info">
                Copy operations: {copyCount}
            </div>
            {Array.from({ length: 3 }, (_, i) => (
                <div key={i} data-testid={`renderer-${i}`}>
                    <MarkdownRenderer
                        content={createContentWithCodeBlocks(i)}
                        id={`renderer-${i}`}
                        isDarkTheme={false}
                        onCopy={handleCopy}
                    />
                </div>
            ))}
        </div>
    );
};

describe('Copy Button Performance Fix', () => {
    beforeEach(() => {
        vi.clearAllMocks();

        // Mock clipboard API
        Object.assign(navigator, {
            clipboard: {
                writeText: vi.fn().mockResolvedValue(void 0),
            },
        });
    });

    it('should render multiple MarkdownRenderers with copy buttons', () => {
        render(<TestMultipleRenderers />);

        // Should have 3 renderers
        expect(screen.getByTestId('renderer-0')).toBeTruthy();
        expect(screen.getByTestId('renderer-1')).toBeTruthy();
        expect(screen.getByTestId('renderer-2')).toBeTruthy();

        // Should have multiple copy buttons (2 per renderer + 1 main = 9 total)
        const copyButtons = document.querySelectorAll('button[title*="Copy"]');
        expect(copyButtons.length).toBe(9);
    });

    it('should handle copy button clicks without performance issues', async () => {
        render(<TestMultipleRenderers />);

        // Get the first copy button
        const firstCopyButton = document.querySelector('button[title*="Copy"]');
        expect(firstCopyButton).toBeTruthy();

        // Track performance
        const startTime = performance.now();

        await act(async () => {
            fireEvent.click(firstCopyButton!);
        });

        const endTime = performance.now();
        const clickTime = endTime - startTime;

        // Should be very fast (under 500ms - this tests there's no major delay)
        expect(clickTime).toBeLessThan(500);

        // Should have called clipboard API
        expect(navigator.clipboard.writeText).toHaveBeenCalled();

        // Should show one copy operation
        const statesInfo = screen.getByTestId('copied-states-info');
        expect(statesInfo.textContent).toContain('1');
    });

    it('should handle multiple rapid clicks efficiently', async () => {
        render(<TestMultipleRenderers />);

        // Get first 3 copy buttons
        const copyButtons = Array.from(
            document.querySelectorAll('button[title*="Copy"]')
        ).slice(0, 3);

        const startTime = performance.now();

        // Click them rapidly
        await act(async () => {
            copyButtons.forEach((button) => {
                fireEvent.click(button);
            });
        });

        const endTime = performance.now();
        const totalTime = endTime - startTime;

        // Should handle multiple clicks quickly
        expect(totalTime).toBeLessThan(200);

        // Should show 3 copy operations
        const statesInfo = screen.getByTestId('copied-states-info');
        expect(statesInfo.textContent).toContain('3');
    });

    it('should demonstrate the memo optimization working', () => {
        let renderCount = 0;

        // Enhanced MarkdownRenderer that counts renders
        const CountingMarkdownRenderer: React.FC<any> = (props) => {
            renderCount++;
            return <MarkdownRenderer {...props} />;
        };

        const TestComponent: React.FC = () => {
            const copyToClipboard = useCopyToClipboard();

            return (
                <div>
                    <div data-testid="render-count">Renders: {renderCount}</div>
                    <CountingMarkdownRenderer
                        content="# Test\n\n```js\nconsole.log('test');\n```"
                        id="test-1"
                        isDarkTheme={false}
                        onCopy={copyToClipboard}
                    />
                    <CountingMarkdownRenderer
                        content="# Test 2\n\n```js\nconsole.log('test2');\n```"
                        id="test-2"
                        isDarkTheme={false}
                        onCopy={copyToClipboard}
                    />
                </div>
            );
        };

        render(<TestComponent />);

        const initialRenderCount = renderCount;

        // Click first component's copy button
        const firstCopyButton = document.querySelector('button[title*="Copy"]');
        fireEvent.click(firstCopyButton!);

        // With individual button state management, clicking should not cause
        // any parent component re-renders beyond the initial render
        expect(renderCount - initialRenderCount).toBeLessThanOrEqual(1);
    });
});
