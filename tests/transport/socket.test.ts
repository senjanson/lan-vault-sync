import { describe, expect, it } from 'vitest';
import { describeSocketError } from '../../src/transport/socket';

describe('describeSocketError', () => {
  it('reads the message from the error events ws and browsers pass', () => {
    expect(describeSocketError(new Error('ECONNREFUSED'))).toBe('ECONNREFUSED');
    expect(describeSocketError({ type: 'error', error: new Error('ECONNRESET'), message: 'ECONNRESET' })).toBe('ECONNRESET');
    expect(describeSocketError({ type: 'error', message: 'connect EHOSTUNREACH' })).toBe('connect EHOSTUNREACH');
    expect(describeSocketError({ type: 'error' })).toBe('connection error');
  });
});
