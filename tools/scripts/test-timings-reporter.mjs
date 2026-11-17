// A node:test reporter that writes how long each test file took, as one JSON object { file: seconds }, to its
// destination. tools/scripts/test.mjs reads it to schedule the longest files first on the next run.
import path from 'node:path';

export default async function* timingsReporter(source) {
  const seconds = {};
  for await (const event of source) {
    // A file is the top-level test (nesting 0) that node reports for each file it ran.
    if (
      (event.type === 'test:pass' || event.type === 'test:fail') &&
      event.data.nesting === 0 &&
      event.data.file
    )
      seconds[path.relative(process.cwd(), event.data.file)] =
        event.data.details.duration_ms / 1000;
  }
  yield JSON.stringify(seconds);
}
