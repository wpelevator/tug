let started = false;

/** A command calls this when it starts real work (a control request, a remote step): an error after that is not a usage mistake. */
export function markWorkStarted(): void {
  started = true;
}

/** Whether a failure should point at the help: the arguments were wrong, rather than the work failing or being cancelled. */
export function isUsageError(message: string): boolean {
  return !started && !/^cancelled/.test(message);
}
