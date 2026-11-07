/** Test helper: answers the keyboard menus of a CLI child process the way a person would, one answer per menu. */
const MENU_START = '\x1b[?25l';

/** Menus fully drawn so far: the cursor is hidden in its own write, so wait for the hint line that ends the title. */
export function menuCount(stderr: string): number {
  return stderr
    .split(MENU_START)
    .slice(1)
    .filter((menu) => menu.includes('cancel)')).length;
}

/**
 * The keystrokes for an answer written as the old numbered prompt took it: "2" picks the second entry, "1,3" toggles
 * the first and third in a multi-choice menu, "q" cancels. A menu is multi-choice when its hint offers space-select.
 */
export function keysFor(answer: string, stderr: string): string {
  if (answer === 'q') return 'q';
  const multiple = stderr.slice(stderr.lastIndexOf(MENU_START)).includes('space select');
  const numbers = answer.split(',').map((part) => part.trim());
  return multiple ? `${numbers.map((n) => `${n} `).join('')}\r` : `${numbers[0]}\r`;
}
