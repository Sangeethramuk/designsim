/**
 * Render a subset of Markdown to HTML.
 * Supports: headings (##, ###), bold, italic, inline code, numbered lists, bullet lists, line breaks.
 * Input is HTML-escaped first to prevent XSS.
 * @param {string} text - The markdown text to render
 * @returns {string} HTML string
 */
export function renderMarkdown(text) {
  let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>');
  s = s.replace(/^## (.+)$/gm, '<div class="md-h2">$1</div>');
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/^(\d+)\. (.+)$/gm, '<div class="md-ol"><span class="md-num">$1.</span>$2</div>');
  s = s.replace(/^[-*•] (.+)$/gm, '<div class="md-li">$1</div>');
  s = s.replace(/\n/g, '<br>');
  return s;
}
