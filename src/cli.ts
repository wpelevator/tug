#!/usr/bin/env node
import { runCli } from './cli/program.ts';

process.exitCode = await runCli(process.argv.slice(2));
