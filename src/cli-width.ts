const segmenter = new Intl.Segmenter();
// East Asian wide and fullwidth blocks; emoji are covered by Emoji_Presentation below.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦\u{1b000}-\u{1b16f}\u{20000}-\u{3fffd}]/u;
/** Zero-width space, joiners, direction marks, word joiner and byte-order mark. */
const isZeroWidth = (grapheme: string): boolean =>
  [...grapheme].every((char) => {
    const code = char.codePointAt(0)!;
    return (code >= 0x200b && code <= 0x200f) || code === 0x2060 || code === 0xfeff;
  });

/** Terminal columns one user-perceived character occupies: 0 for zero-width marks, 2 for wide characters and emoji, else 1. */
function graphemeWidth(grapheme: string): number {
  if (isZeroWidth(grapheme)) return 0;
  // Keycaps (1️⃣), emoji-presentation selectors (❤️) and flags are drawn two columns wide.
  if (WIDE.test(grapheme) || /\p{Emoji_Presentation}|⃣|️|\p{Regional_Indicator}/u.test(grapheme))
    return 2;
  return 1;
}

/** Terminal columns `text` occupies. */
export function columnWidth(text: string): number {
  let width = 0;
  for (const part of segmenter.segment(text)) width += graphemeWidth(part.segment);
  return width;
}

/** `text` cut to at most `columns` terminal columns, ending in an ellipsis when it was cut. */
export function clipToColumns(text: string, columns: number): string {
  if (columnWidth(text) <= columns) return text;
  let used = 0;
  let out = '';
  for (const part of segmenter.segment(text)) {
    const width = graphemeWidth(part.segment);
    if (used + width > columns - 1) break;
    out += part.segment;
    used += width;
  }
  return `${out}…`;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** One line of plain text: control characters would break cursor arithmetic or inject escapes into the terminal. */
export const plainText = (text: string): string => text.replace(CONTROL_CHARACTERS, ' ');
