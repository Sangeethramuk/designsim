/**
 * Escape HTML special characters to prevent XSS.
 * @param {*} s - The value to escape (null/undefined become empty string)
 * @returns {string} The escaped string
 */
export function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
