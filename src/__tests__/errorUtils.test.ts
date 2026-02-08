import { describe, it, expect } from 'vitest';
import { getErrorMessage } from '../utils/errorUtils';

describe('getErrorMessage', () => {
    it('should extract message from Error instance', () => {
        const error = new Error('Something went wrong');
        expect(getErrorMessage(error)).toBe('Something went wrong');
    });

    it('should handle primitive string', () => {
        expect(getErrorMessage('string error')).toBe('string error');
    });

    it('should handle primitive number', () => {
        expect(getErrorMessage(42)).toBe('42');
    });

    it('should handle null', () => {
        expect(getErrorMessage(null)).toBe('null');
    });

    it('should handle undefined', () => {
        expect(getErrorMessage(undefined)).toBe('undefined');
    });

    it('should handle object with custom toString', () => {
        const obj = {
            toString() {
                return 'custom message';
            },
        };
        expect(getErrorMessage(obj)).toBe('custom message');
    });

    it('should handle object whose toString throws', () => {
        const badObj = {
            toString() {
                throw new Error('boom');
            },
        };
        // Should fallback to JSON.stringify
        expect(getErrorMessage(badObj)).toBe('{}');
    });

    it('should handle object where both toString and JSON.stringify fail', () => {
        const badObj = {
            toString() {
                throw new Error('boom');
            },
            toJSON() {
                throw new Error('also boom');
            },
        };
        // Should fallback to Object.prototype.toString
        expect(getErrorMessage(badObj)).toBe('[object Object]');
    });

    it('should handle circular object reference', () => {
        interface CircularObj {
            self?: CircularObj;
        }
        const circularObj: CircularObj = {};
        circularObj.self = circularObj;
        // String() will work on circular objects (returns [object Object])
        expect(getErrorMessage(circularObj)).toBe('[object Object]');
    });

    it('should handle array', () => {
        expect(getErrorMessage([1, 2, 3])).toBe('1,2,3');
    });

    it('should handle empty object', () => {
        expect(getErrorMessage({})).toBe('[object Object]');
    });

    it('should extract message from plain object with message property', () => {
        const error = { message: 'plain object error', code: 'ETIMEOUT' };
        expect(getErrorMessage(error)).toBe('plain object error');
    });

    it('should ignore non-string message property', () => {
        const error = { message: 42 };
        // Falls through to String() since message is not a string
        expect(getErrorMessage(error)).toBe('[object Object]');
    });
});
