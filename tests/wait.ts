import assert from 'node:assert/strict';

/**
 * Waits for something asynchronous to become true, then returns what it saw. Tests use this instead of sleeping a fixed
 * time and asserting afterwards: a sleep is a guess about how fast the machine is, and CI runners that run test files in
 * parallel are slower than a laptop at unpredictable moments, so a guess that passes locally fails there now and then.
 *
 * The deadline is generous on purpose. It only matters when the awaited thing never happens, so a passing test never
 * pays for it, and a slow machine does not turn into a failure. The failure names what was awaited.
 *
 * A fixed sleep is still right for the opposite claim, that something does NOT happen, because there is nothing to wait for.
 * Wait for the last positive signal first and then assert the absence.
 */
export async function until<T>(
  condition: () => T | Promise<T>,
  what: string,
  { timeoutMs = 20_000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
