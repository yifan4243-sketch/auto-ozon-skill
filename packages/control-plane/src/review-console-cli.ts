#!/usr/bin/env node
import { startReviewConsole } from './review-console.js';

const portArgument = process.argv.indexOf('--port');
const port = portArgument >= 0 ? Number(process.argv[portArgument + 1]) : 0;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write('auto-ozon-review-console: --port must be 0..65535\n');
  process.exitCode = 2;
} else {
  startReviewConsole({ port }).then((running) => {
    process.stdout.write(`Auto Ozon review console: ${running.url}\nPress Ctrl+C to stop.\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`auto-ozon-review-console: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
