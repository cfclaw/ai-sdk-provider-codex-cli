import { describe, expect, it } from 'vitest';
import { decodeJwtPayload, extractAccountId, getJwtExpiryMs } from '../../oauth/jwt.js';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('decodeJwtPayload', () => {
  it('decodes a well-formed JWT payload', () => {
    const token = makeJwt({ foo: 'bar' });
    expect(decodeJwtPayload(token)).toEqual({ foo: 'bar' });
  });

  it('returns null for malformed tokens', () => {
    expect(decodeJwtPayload('')).toBeNull();
    expect(decodeJwtPayload('not.a.jwt-but-three-parts')).toBeNull();
    expect(decodeJwtPayload('only.two')).toBeNull();
  });

  it('returns null when payload is not a JSON object', () => {
    const arrayPayload = [
      Buffer.from('{}').toString('base64url'),
      Buffer.from('[1,2,3]').toString('base64url'),
      'sig',
    ].join('.');
    expect(decodeJwtPayload(arrayPayload)).toBeNull();
  });
});

describe('extractAccountId', () => {
  it('reads the top-level chatgpt_account_id claim', () => {
    const token = makeJwt({ chatgpt_account_id: 'acc-top' });
    expect(extractAccountId(token)).toBe('acc-top');
  });

  it('falls back to the namespaced claim', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc-namespaced' },
    });
    expect(extractAccountId(token)).toBe('acc-namespaced');
  });

  it('falls back to organizations[0].id', () => {
    const token = makeJwt({ organizations: [{ id: 'org-123' }, { id: 'org-456' }] });
    expect(extractAccountId(token)).toBe('org-123');
  });

  it('prefers the id_token over the access_token when both are provided', () => {
    const access = makeJwt({ chatgpt_account_id: 'acc-access' });
    const id = makeJwt({ chatgpt_account_id: 'acc-id' });
    expect(extractAccountId(access, id)).toBe('acc-id');
  });

  it('returns undefined when no claim is present', () => {
    const token = makeJwt({ unrelated: 'value' });
    expect(extractAccountId(token)).toBeUndefined();
  });
});

describe('getJwtExpiryMs', () => {
  it('returns the exp claim as epoch milliseconds', () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 3600;
    const token = makeJwt({ exp: expSeconds });
    expect(getJwtExpiryMs(token)).toBe(expSeconds * 1000);
  });

  it('returns undefined when exp is missing or not a number', () => {
    expect(getJwtExpiryMs(makeJwt({}))).toBeUndefined();
    expect(getJwtExpiryMs(makeJwt({ exp: 'soon' }))).toBeUndefined();
  });

  it('returns undefined for malformed tokens', () => {
    expect(getJwtExpiryMs('not-a-jwt')).toBeUndefined();
    expect(getJwtExpiryMs('')).toBeUndefined();
  });
});
