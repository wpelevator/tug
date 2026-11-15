// Ingress overhead: run ApacheBench against a direct URL and the same application through the proxy, and print one
// table. ab runs on --load-host over SSH (or locally with `local`), so it needs ApacheBench (`ab`, package
// apache2-utils or httpd-tools) on that machine. Each run's full ab output is saved so failed requests can be classified.
//
//   node tools/scripts/bench-ingress.mjs --load-host 203.0.113.10 --key ~/.ssh/id_ed25519 \
//     --target express=http://10.50.0.4:8080/health,https://express.example.com/health \
//     --concurrency 10,50 --requests 20000 --out ingress-results
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  benchmarkIngress,
  classifyFailures,
  createRunner,
  formatIngressTable,
  LOCAL,
} from './real-host-lib.mjs';

/** `name=directUrl,proxiedUrl` to a target. */
export function parseTarget(text) {
  const match = /^([^=]+)=(\S+?),(\S+)$/.exec(text);
  if (!match)
    throw new Error(`--target must be name=directUrl,proxiedUrl, got ${JSON.stringify(text)}`);
  return { name: match[1], direct: match[2], proxied: match[3] };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'load-host': { type: 'string', default: LOCAL },
      key: { type: 'string' },
      user: { type: 'string', default: 'root' },
      target: { type: 'string', multiple: true },
      concurrency: { type: 'string', default: '10,50' },
      requests: { type: 'string', default: '20000' },
      out: {
        type: 'string',
        default: `ingress-results-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      },
    },
  });
  if (!values.target?.length)
    throw new Error('give at least one --target name=directUrl,proxiedUrl');
  mkdirSync(values.out, { recursive: true });
  const rows = await benchmarkIngress({
    runner: createRunner({ key: values.key, user: values.user }),
    loadHost: values['load-host'],
    targets: values.target.map(parseTarget),
    concurrencies: values.concurrency.split(',').map(Number),
    requests: Number(values.requests),
    onOutput: (name, raw) => writeFileSync(join(values.out, `${name}.txt`), raw),
  });
  writeFileSync(join(values.out, 'summary.json'), JSON.stringify(rows, null, 2));
  console.log(formatIngressTable(rows));
  const failures = classifyFailures(rows);
  if (failures.length) console.log(`\n${failures.join('\n')}`);
  console.log(`\nab output saved in ${values.out}/`);
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
