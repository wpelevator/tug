// Request a URL every N ms while a command runs, then report probes, non-200 responses, the version distribution and
// the maximum latency. The command is whatever disturbs the service: a redeploy, `tug upgrade`, a rolling rollout, a
// bad version with `rollback: auto`. Run it on the machine that should observe the outage (for example the load host).
// The probe is a plain HTTP(S) GET; certificate errors count as failed probes.
//
//   node tools/scripts/probe-loop.mjs --url https://express.example.com/ --interval-ms 50 \
//     --version-pattern 'version: (\S+)' -- tug deploy -f compose.yaml
import http from 'node:http';
import https from 'node:https';
import { parseArgs } from 'node:util';
import { formatProbeSummary, probeWhile, summarizeProbes } from './real-host-lib.mjs';
import { spawn } from 'node:child_process';

/** One GET with a timeout, returning status, body and elapsed milliseconds. */
export function httpProbe(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { timeout: timeoutMs, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body, ms: Date.now() - started }),
      );
    });
    request.on('timeout', () => request.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    request.on('error', reject);
  });
}

/** A version label extractor: the first capture group of `pattern`, else the whole trimmed body. */
export function versionFrom(pattern) {
  if (!pattern) return (body) => body.trim().slice(0, 40);
  const regex = new RegExp(pattern);
  return (body) => regex.exec(body)?.[1] ?? 'unmatched';
}

const runCommand = (argv) =>
  new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (status) => resolve(status ?? 1));
  });

async function main() {
  const split = process.argv.indexOf('--');
  const command = split === -1 ? [] : process.argv.slice(split + 1);
  const { values } = parseArgs({
    args: split === -1 ? process.argv.slice(2) : process.argv.slice(2, split),
    options: {
      url: { type: 'string' },
      'interval-ms': { type: 'string', default: '50' },
      'version-pattern': { type: 'string' },
    },
  });
  if (!values.url || !command.length)
    throw new Error(
      'usage: probe-loop.mjs --url URL [--interval-ms N] [--version-pattern RE] -- command...',
    );
  const {
    probes,
    work: status,
    failure,
  } = await probeWhile({
    work: () => runCommand(command),
    probe: httpProbe,
    url: values.url,
    intervalMs: Number(values['interval-ms']),
    version: versionFrom(values['version-pattern']),
  });
  console.log(`\ncommand exit status: ${failure ? `error (${failure.message})` : status}`);
  console.log(formatProbeSummary(summarizeProbes(probes)));
  if (failure || status !== 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
