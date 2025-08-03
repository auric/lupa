import React, { useState, useRef, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface CopyButtonProps {
    text: string;
    className?: string;
    onCopy?: (text: string) => void;
}

export const CopyButton: React.FC<CopyButtonProps> = ({
    text,
    className,
    onCopy
}) => {
    const [isCopied, setIsCopied] = useState(false);
    const timeoutRef = useRef<NodeJS.Timeout | null>(null);

    const handleClick = useCallback(() => {
        // Clear any existing timeout
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
        }

        // Set copied state immediately for instant feedback
        setIsCopied(true);

        // Call the onCopy handler (which does the actual clipboard operation)
        onCopy?.(text);

        // Reset state after 1 second
        timeoutRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutRef.current = null;
        }, 1000);
    }, [text, onCopy]);

    return (
        <Button
            variant="outline"
            size="sm"
            onClick={handleClick}
            className={cn("h-8 w-8 p-0 opacity-70 hover:opacity-100 transition-opacity", className)}
            title={isCopied ? "Copied!" : "Copy to clipboard"}
        >
            {isCopied ? (
                <Check className="h-4 w-4 text-green-500" />
            ) : (
                <Copy className="h-4 w-4" />
            )}
        </Button>
    );
};