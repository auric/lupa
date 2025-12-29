/**
 * Execute a callback when the DOM is ready.
 *
 * Module scripts have implicit `defer`, meaning they execute AFTER DOMContentLoaded
 * has already fired. Using `document.addEventListener('DOMContentLoaded', ...)` in
 * a module script may never trigger because the event already happened.
 *
 * This utility handles both cases:
 * - If document is still loading, waits for DOMContentLoaded
 * - If document is already interactive/complete, executes immediately
 */
export function onDomReady(callback: () => void): void {
    if (document.readyState === 'loading') {
        // DOM is still loading, wait for it
        document.addEventListener('DOMContentLoaded', callback);
    } else {
        // DOM is already ready (interactive or complete)
        callback();
    }
}
