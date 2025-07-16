import { useState } from 'react';

/**
 * Custom hook for handling copy to clipboard functionality
 * @returns object with copyToClipboard function and copiedStates
 */
export const useCopyToClipboard = () => {
    const [copiedStates, setCopiedStates] = useState<Record<string, boolean>>({});

    const copyToClipboard = async (text: string, id: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedStates(prev => ({ ...prev, [id]: true }));
            setTimeout(() => {
                setCopiedStates(prev => ({ ...prev, [id]: false }));
            }, 1000);
        } catch (err) {
            console.error('Failed to copy text: ', err);
        }
    };

    return { copyToClipboard, copiedStates };
};