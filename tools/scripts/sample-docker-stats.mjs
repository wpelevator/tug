// Sample `docker stats` on hosts and print average and peak CPU and memory of the tug agent (tug-agent), Caddy
// (tug-caddy) and control (tug-control-control-1) containers. Start it before the load or deploy and stop it with the
// sample count. Hosts are SSH addresses, or `local` for this machine.
//
//   node tools/scripts/sample-docker-stats.mjs --host 203.0.113.10 --host 203.0.113.11 --key ~/.ssh/id_ed25519 \
//     --samples 30 --interval 2
import { parseArgs } from 'node:util';
import { createRunner, formatStatsTable, sampleStats, summarizeStats } from './real-host-lib.mjs';

async function main() {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', multiple: true },
      key: { type: 'string' },
      user: { type: 'string', default: 'root' },
      samples: { type: 'string', default: '30' },
      interval: { type: 'string', default: '2' },
    },
  });
  if (!values.host?.length) throw new Error('give at least one --host (an SSH address or local)');
  const readings = await sampleStats({
    runner: createRunner({ key: values.key, user: values.user }),
    hosts: values.host,
    samples: Number(values.samples),
    intervalMs: Number(values.interval) * 1000,
  });
  if (!readings.length) throw new Error('no tug containers were found in the docker stats output');
  console.log(formatStatsTable(summarizeStats(readings)));
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
