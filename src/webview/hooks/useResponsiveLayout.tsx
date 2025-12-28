import { useState, useEffect } from 'react';

export type LayoutMode = 'standard' | 'compact' | 'focus';

interface ResponsiveLayoutResult {
    /** Current layout mode */
    mode: LayoutMode;
    /** Current window width */
    width: number;
    /** Whether the layout is in mobile/narrow view */
    isMobile: boolean;
    /** Whether panels should be stacked */
    shouldStack: boolean;
}

/**
 * Hook for managing responsive layout modes based on window size
 */
export const useResponsiveLayout = (): ResponsiveLayoutResult => {
    const [width, setWidth] = useState(
        typeof window !== 'undefined' ? window.innerWidth : 1200
    );
    const [mode, setMode] = useState<LayoutMode>('standard');

    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        const handleResize = () => {
            const newWidth = window.innerWidth;
            setWidth(newWidth);

            // Determine layout mode based on width
            if (newWidth < 800) {
                setMode('compact');
            } else if (newWidth < 1000) {
                setMode('standard');
            } else {
                setMode('standard'); // Could add 'focus' mode for very wide screens
            }
        };

        // Initial setup
        handleResize();

        // Add event listener
        window.addEventListener('resize', handleResize);

        // Cleanup
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const isMobile = width < 800;
    const shouldStack = width < 800;

    return {
        mode,
        width,
        isMobile,
        shouldStack,
    };
};
