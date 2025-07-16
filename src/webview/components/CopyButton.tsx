import React from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface CopyButtonProps {
    text: string;
    id: string;
    className?: string;
    onCopy?: (text: string, id: string) => void;
    isCopied?: boolean;
}

export const CopyButton: React.FC<CopyButtonProps> = ({ 
    text, 
    id, 
    className,
    onCopy,
    isCopied = false
}) => (
    <Button
        variant="outline"
        size="sm"
        onClick={() => onCopy?.(text, id)}
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