import { useState, useEffect } from 'react';

/**
 * Custom hook for detecting VSCode theme (light/dark)
 * Uses vscode.window.activeColorTheme from extension host via postMessage
 * @returns boolean indicating if dark theme is active
 */
export const useTheme = () => {
    // Initialize with theme data from window object (no race condition)
    const [isDarkTheme, setIsDarkTheme] = useState<boolean>(() => {
        const initialTheme = (window as any).initialTheme;
        return initialTheme?.isDarkTheme ?? false;
    });

    useEffect(() => {
        // Listen for theme messages from extension host
        const handleMessage = (event: MessageEvent) => {
            if (event.data.type === 'theme-changed') {
                const themeData = event.data.data;
                console.log('Theme changed via vscode.window.activeColorTheme:', themeData);
                setIsDarkTheme(themeData.isDarkTheme);
            }
        };

        // Set up message listener for extension host communication
        window.addEventListener('message', handleMessage);

        // Cleanup
        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, []);

    return isDarkTheme;
};