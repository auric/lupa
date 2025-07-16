import { useState, useEffect } from 'react';

/**
 * Custom hook for detecting VSCode theme (light/dark)
 * @returns boolean indicating if dark theme is active
 */
export const useTheme = () => {
    const [isDarkTheme, setIsDarkTheme] = useState<boolean>(false);

    useEffect(() => {
        const detectTheme = () => {
            const bodyStyle = getComputedStyle(document.body);
            const bgColor = bodyStyle.getPropertyValue('--vscode-editor-background');

            // Parse RGB/hex color and calculate luminance
            const getLuminance = (color: string): number => {
                // Remove spaces and normalize
                const normalized = color.trim();

                let r = 0, g = 0, b = 0;

                // Handle different color formats
                if (normalized.startsWith('#')) {
                    // Hex format
                    const hex = normalized.slice(1);
                    r = parseInt(hex.slice(0, 2), 16);
                    g = parseInt(hex.slice(2, 4), 16);
                    b = parseInt(hex.slice(4, 6), 16);
                } else if (normalized.startsWith('rgb')) {
                    // RGB format
                    const values = normalized.match(/\d+/g);
                    if (values && values.length >= 3) {
                        r = parseInt(values[0]);
                        g = parseInt(values[1]);
                        b = parseInt(values[2]);
                    }
                }

                // Calculate relative luminance
                const normalizeComponent = (c: number) => {
                    c = c / 255;
                    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
                };

                return 0.2126 * normalizeComponent(r) + 0.7152 * normalizeComponent(g) + 0.0722 * normalizeComponent(b);
            };

            const luminance = getLuminance(bgColor);
            const isDark = luminance < 0.5;
            console.log('Theme detection:', { bgColor, luminance, isDark });
            setIsDarkTheme(isDark);
        };

        detectTheme();
        // Re-detect theme if CSS variables change
        const observer = new MutationObserver(detectTheme);
        observer.observe(document.documentElement, { 
            attributes: true, 
            attributeFilter: ['style', 'class'] 
        });

        return () => observer.disconnect();
    }, []);

    return isDarkTheme;
};