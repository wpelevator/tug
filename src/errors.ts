export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Node's fetch reports every network failure as "fetch failed"; the system error that explains it is on `cause`. */
export function describeFetchError(error: unknown): string {
  const e = error as { message?: string; cause?: { code?: string; message?: string } } | undefined;
  const cause = e?.cause?.code || e?.cause?.message;
  return cause ? `${e?.message ?? 'error'} (${cause})` : errMessage(error);
}
