import { describe, it, expect } from 'vitest';
import {
  stripHtml,
  generateId,
  isPrivateUrl,
  validateString,
  validateUrl,
  validateFileKey,
  buildVariablesPayload,
  sanitizeSharedHtml,
  escapeHtmlText,
} from '../worker/src/index.js';

describe('stripHtml', () => {
  it('removes script tags and content', () => {
    const result = stripHtml('<p>Hello</p><script>alert(1)</script>', 'http://example.com', '');
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('alert');
    expect(result).toContain('Hello');
  });

  it('removes style tags', () => {
    const result = stripHtml('<style>.x{color:red}</style><p>Hi</p>', 'http://example.com', '');
    expect(result).not.toContain('<style>');
    expect(result).toContain('Hi');
  });

  it('decodes HTML entities', () => {
    const result = stripHtml('<p>&lt;tag&gt; &amp; &quot;quote&quot;</p>', 'http://example.com', '');
    expect(result).toContain('<tag>');
    expect(result).toContain('&');
    expect(result).toContain('"quote"');
  });

  it('truncates long content', () => {
    const long = '<p>' + 'A'.repeat(10000) + '</p>';
    const result = stripHtml(long, 'http://example.com', '');
    expect(result).toContain('truncated');
    expect(result.length).toBeLessThan(6000);
  });

  it('includes URL and reason in output', () => {
    const result = stripHtml('<p>Test</p>', 'http://example.com', 'research');
    expect(result).toContain('http://example.com');
    expect(result).toContain('research');
  });
});

describe('generateId', () => {
  it('generates an ID of the specified length', () => {
    expect(generateId(8)).toHaveLength(8);
    expect(generateId(12)).toHaveLength(12);
    expect(generateId(4)).toHaveLength(4);
  });

  it('uses only lowercase alphanumeric characters', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateId(20);
      expect(id).toMatch(/^[a-z0-9]+$/);
    }
  });

  it('generates unique IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 200; i++) {
      ids.add(generateId(8));
    }
    expect(ids.size).toBeGreaterThan(190);
  });
});

describe('isPrivateUrl', () => {
  it('blocks localhost', () => {
    expect(isPrivateUrl('http://localhost:3000/')).toBe(true);
    expect(isPrivateUrl('http://127.0.0.1:8080/')).toBe(true);
    expect(isPrivateUrl('http://0.0.0.0/')).toBe(true);
  });

  it('blocks private IP ranges', () => {
    expect(isPrivateUrl('http://10.0.0.1/')).toBe(true);
    expect(isPrivateUrl('http://192.168.1.1/')).toBe(true);
    expect(isPrivateUrl('http://172.16.0.1/')).toBe(true);
    expect(isPrivateUrl('http://172.31.255.255/')).toBe(true);
  });

  it('blocks cloud metadata endpoints', () => {
    expect(isPrivateUrl('http://169.254.169.254/latest/meta-data/')).toBe(true);
    expect(isPrivateUrl('http://metadata.google.internal/computeMetadata/')).toBe(true);
  });

  it('blocks link-local addresses', () => {
    expect(isPrivateUrl('http://169.254.1.1/')).toBe(true);
  });

  it('blocks non-HTTP schemes', () => {
    expect(isPrivateUrl('file:///etc/passwd')).toBe(true);
    expect(isPrivateUrl('ftp://example.com/')).toBe(true);
  });

  it('blocks invalid URLs', () => {
    expect(isPrivateUrl('not-a-url')).toBe(true);
    expect(isPrivateUrl('')).toBe(true);
  });

  it('allows public URLs', () => {
    expect(isPrivateUrl('https://example.com/')).toBe(false);
    expect(isPrivateUrl('http://93.184.216.34/')).toBe(false);
  });

  it('blocks IPv6 link-local', () => {
    expect(isPrivateUrl('http://[fe80::1]/')).toBe(true);
    expect(isPrivateUrl('http://[fc00::1]/')).toBe(true);
  });

  it('blocks CGNAT range', () => {
    expect(isPrivateUrl('http://100.64.0.1/')).toBe(true);
    expect(isPrivateUrl('http://100.127.255.255/')).toBe(true);
  });

  it('blocks multicast/reserved', () => {
    expect(isPrivateUrl('http://224.0.0.1/')).toBe(true);
    expect(isPrivateUrl('http://240.0.0.1/')).toBe(true);
  });
});

describe('validateString', () => {
  it('accepts valid strings', () => {
    expect(validateString('hello', 'field').ok).toBe(true);
    expect(validateString('test', 'field', 100).ok).toBe(true);
  });

  it('rejects non-strings', () => {
    expect(validateString(123, 'field').ok).toBe(false);
    expect(validateString(null, 'field').ok).toBe(false);
    expect(validateString(undefined, 'field').ok).toBe(false);
    expect(validateString({}, 'field').ok).toBe(false);
  });

  it('rejects strings exceeding max length', () => {
    expect(validateString('a'.repeat(101), 'field', 100).ok).toBe(false);
  });
});

describe('validateUrl', () => {
  it('accepts valid HTTP/HTTPS URLs', () => {
    expect(validateUrl('http://example.com').ok).toBe(true);
    expect(validateUrl('https://example.com/path?q=1').ok).toBe(true);
  });

  it('rejects non-HTTP schemes', () => {
    expect(validateUrl('ftp://example.com').ok).toBe(false);
    expect(validateUrl('javascript:alert(1)').ok).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(validateUrl(123).ok).toBe(false);
    expect(validateUrl(null).ok).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(validateUrl('not a url').ok).toBe(false);
    expect(validateUrl('').ok).toBe(false);
  });
});

describe('validateFileKey', () => {
  it('accepts alphanumeric file keys', () => {
    expect(validateFileKey('abc123').ok).toBe(true);
    expect(validateFileKey('XYZ789').ok).toBe(true);
  });

  it('rejects non-alphanumeric characters', () => {
    expect(validateFileKey('abc-123').ok).toBe(false);
    expect(validateFileKey('abc_123').ok).toBe(false);
    expect(validateFileKey('abc 123').ok).toBe(false);
    expect(validateFileKey('../../../etc').ok).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(validateFileKey(123).ok).toBe(false);
    expect(validateFileKey(null).ok).toBe(false);
  });
});

describe('buildVariablesPayload', () => {
  it('builds a valid payload from colors array', () => {
    const colors = [
      { name: 'primary', r: 74, g: 158, b: 234 },
      { name: 'accent', r: 74, g: 206, b: 160 },
    ];
    const payload = buildVariablesPayload(colors);

    expect(payload.variableCollections).toHaveLength(1);
    expect(payload.variableCollections[0].name).toBe('Design Floor Tokens');
    expect(payload.variableModes).toHaveLength(1);
    expect(payload.variables).toHaveLength(2);
    expect(payload.variables[0].name).toBe('primary');
    expect(payload.variables[1].name).toBe('accent');
    expect(payload.variableModeValues).toHaveLength(2);
    expect(payload.variableModeValues[0].value).toEqual({ r: 74, g: 158, b: 234, a: 1 });
  });

  it('handles empty colors array', () => {
    const payload = buildVariablesPayload([]);
    expect(payload.variables).toHaveLength(0);
    expect(payload.variableModeValues).toHaveLength(0);
  });
});

describe('sanitizeSharedHtml', () => {
  it('removes meta refresh redirects', () => {
    const html = '<meta http-equiv="refresh" content="0;url=http://evil.com"><p>Hi</p>';
    const result = sanitizeSharedHtml(html);
    expect(result).not.toContain('refresh');
    expect(result).toContain('Hi');
  });

  it('removes base tags', () => {
    const html = '<base href="http://evil.com/"><p>Hi</p>';
    const result = sanitizeSharedHtml(html);
    expect(result).not.toContain('<base');
  });

  it('removes object/embed/applet tags', () => {
    const html = '<object data="evil.swf"></object><embed src="evil.swf"><applet code="Evil.class"></applet>';
    const result = sanitizeSharedHtml(html);
    expect(result).not.toContain('<object');
    expect(result).not.toContain('<embed');
    expect(result).not.toContain('<applet');
  });

  it('preserves safe content', () => {
    const html = '<h1>Title</h1><p>Paragraph</p><div>Content</div>';
    const result = sanitizeSharedHtml(html);
    expect(result).toBe(html);
  });
});

describe('escapeHtmlText', () => {
  it('escapes ampersands', () => {
    expect(escapeHtmlText('a&b')).toBe('a&amp;b');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtmlText('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes quotes', () => {
    expect(escapeHtmlText('"hello"')).toBe('&quot;hello&quot;');
  });

  it('handles non-string input', () => {
    expect(escapeHtmlText(null)).toBe('null');
    expect(escapeHtmlText(123)).toBe('123');
  });
});
