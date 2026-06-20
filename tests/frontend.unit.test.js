import { describe, it, expect } from 'vitest';
import { escHtml } from '../src/lib/utils.js';
import { renderMarkdown } from '../src/lib/markdown.js';

describe('escHtml', () => {
  it('escapes ampersands', () => {
    expect(escHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes angle brackets', () => {
    expect(escHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('handles null and undefined', () => {
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
  });

  it('handles non-string input by converting to string', () => {
    expect(escHtml(42)).toBe('42');
    expect(escHtml(true)).toBe('true');
  });

  it('handles empty string', () => {
    expect(escHtml('')).toBe('');
  });

  it('escapes all special characters at once', () => {
    expect(escHtml('<a href="x">Tom & Jerry</a>')).toBe(
      '&lt;a href="x"&gt;Tom &amp; Jerry&lt;/a&gt;'
    );
  });
});

describe('renderMarkdown', () => {
  it('escapes HTML to prevent XSS', () => {
    const result = renderMarkdown('<script>alert(1)</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('renders h3 headings', () => {
    const result = renderMarkdown('### My Heading');
    expect(result).toContain('<div class="md-h3">My Heading</div>');
  });

  it('renders h2 headings', () => {
    const result = renderMarkdown('## My Heading');
    expect(result).toContain('<div class="md-h2">My Heading</div>');
  });

  it('renders bold text', () => {
    const result = renderMarkdown('**bold**');
    expect(result).toContain('<strong>bold</strong>');
  });

  it('renders italic text', () => {
    const result = renderMarkdown('*italic*');
    expect(result).toContain('<em>italic</em>');
  });

  it('renders bold-italic text', () => {
    const result = renderMarkdown('***both***');
    expect(result).toContain('<strong><em>both</em></strong>');
  });

  it('renders inline code', () => {
    const result = renderMarkdown('Use `npm test` to run');
    expect(result).toContain('<code>npm test</code>');
  });

  it('renders numbered lists', () => {
    const result = renderMarkdown('1. First item');
    expect(result).toContain('<div class="md-ol">');
    expect(result).toContain('<span class="md-num">1.</span>');
    expect(result).toContain('First item');
  });

  it('renders bullet lists with dash', () => {
    const result = renderMarkdown('- Bullet item');
    expect(result).toContain('<div class="md-li">Bullet item</div>');
  });

  it('renders bullet lists with asterisk', () => {
    const result = renderMarkdown('* Bullet item');
    expect(result).toContain('<div class="md-li">Bullet item</div>');
  });

  it('renders bullet lists with bullet char', () => {
    const result = renderMarkdown('• Bullet item');
    expect(result).toContain('<div class="md-li">Bullet item</div>');
  });

  it('converts newlines to <br>', () => {
    const result = renderMarkdown('Line 1\nLine 2');
    expect(result).toContain('Line 1<br>Line 2');
  });

  it('handles combined formatting', () => {
    const result = renderMarkdown('## Title\n\n- **Bold item** with `code`');
    expect(result).toContain('<div class="md-h2">Title</div>');
    expect(result).toContain('<strong>Bold item</strong>');
    expect(result).toContain('<code>code</code>');
  });

  it('handles empty string', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('preserves plain text', () => {
    const result = renderMarkdown('Just plain text');
    expect(result).toContain('Just plain text');
  });
});
