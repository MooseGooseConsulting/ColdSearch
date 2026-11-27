/**
 * Whether `pattern` matches the whole of `text`, where `*` in the pattern
 * stands for any run of characters (none included) and every other character
 * stands for itself.
 *
 * Patterns and text both come from outside (a site's robots.txt and its
 * links, an upstream's tool names), so this is not a regular expression:
 * `a*a*a*b` compiled to one takes time exponential in the number of stars on
 * text that almost matches. Here the first and last pieces are compared in
 * place and each piece between stars is searched for once, left to right,
 * which is enough because the earliest place a piece fits leaves the most
 * room for the pieces after it.
 */
export function globMatch(text: string, pattern: string): boolean {
  const pieces = pattern.split("*");
  if (pieces.length === 1) return text === pattern;

  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  const end = text.length - last.length;
  if (end < first.length || !text.startsWith(first) || !text.endsWith(last)) return false;

  let at = first.length;
  for (let index = 1; index < pieces.length - 1; index++) {
    const piece = pieces[index];
    const found = text.indexOf(piece, at);
    if (found === -1 || found + piece.length > end) return false;
    at = found + piece.length;
  }
  return true;
}
