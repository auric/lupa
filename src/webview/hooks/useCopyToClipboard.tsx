/**
 * Ultra-simple copy to clipboard hook that doesn't manage any state
 * Each button manages its own state individually to prevent cascade re-renders
 * React Compiler handles memoization automatically
 */
export const useCopyToClipboard = () => {
    const copyToClipboard = (text: string) => {
        // Just perform the clipboard operation - no state management here
        navigator.clipboard.writeText(text).catch((err) => {
            console.error('Failed to copy text: ', err);
        });
    };

    return copyToClipboard;
};
