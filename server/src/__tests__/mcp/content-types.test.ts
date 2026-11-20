import { describe, expect, it } from 'vitest';
import { isInlineBinary, isTextLike, utf8ContentType } from '../../mcp/content-types.ts';

describe('content types over MCP', () => {
  it.each([
    ['text/markdown', true],
    ['text/csv; charset=utf-8', true],
    ['application/json', true],
    ['application/ld+json', true],
    ['image/svg+xml', true],
    ['Application/XML', true],
    ['image/png', false],
    ['application/pdf', false],
    ['application/octet-stream', false],
  ])('reads %s as text: %s', (type, expected) => {
    expect(isTextLike(type)).toBe(expected);
  });

  it.each([
    ['image/png', true],
    ['application/pdf', true],
    ['image/svg+xml', false],
    ['application/zip', false],
  ])('hands %s over as a resource: %s', (type, expected) => {
    expect(isInlineBinary(type)).toBe(expected);
  });

  it.each([
    ['text/markdown', 'text/markdown; charset=utf-8'],
    ['application/json', 'application/json; charset=utf-8'],
    ['text/html; charset=ISO-8859-1', 'text/html; charset=ISO-8859-1'],
    ['text/plain; CharSet=utf-8', 'text/plain; CharSet=utf-8'],
    ['application/octet-stream', 'application/octet-stream'],
  ])('stores inline text of %s as %s', (type, stored) => {
    expect(utf8ContentType(type)).toBe(stored);
  });
});
