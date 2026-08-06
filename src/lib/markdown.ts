const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);

/**
 * Lighthouse audit descriptions are markdown-ish: `[text](url)` links and
 * `code` spans. They are the "why this matters" copy, so they are worth
 * rendering rather than showing raw.
 *
 * Escaping happens FIRST and linkification second, so any HTML in the source
 * string is inert and the only live tags are the ones added here.
 */
export const renderDescription = (text: string): string =>
  escapeHtml(text)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    )
    .replace(/`([^`]+)`/g, '<code>$1</code>');
