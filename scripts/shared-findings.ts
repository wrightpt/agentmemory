import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FindingClient,
  FindingClientError,
  FINDING_COMMANDS,
  FINDING_REQUEST_MAX_BYTES,
  type FindingCommand,
  type FindingRequests,
} from '../src/findings/client.js';

const usage = 'Usage: npm run findings -- <prepare|publish|snapshot|expand|correct> [--input request.json|-] [--url http://127.0.0.1:3111]';

export async function runFindingCli(args: string[]): Promise<unknown> {
  if (args.length === 1 && args[0] === '--help') return { usage };
  const command = args[0] as FindingCommand;
  if (!FINDING_COMMANDS.includes(command)) throw new FindingClientError('finding_invalid_command');
  let input = '-';
  let url: string | undefined;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!value || seen.has(option) || !['--input', '--url'].includes(option)) {
      throw new FindingClientError('finding_invalid_arguments');
    }
    seen.add(option);
    if (option === '--input') input = value;
    else url = value;
  }
  const client = new FindingClient({ url });
  const stream = input === '-' ? process.stdin : createReadStream(input);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > FINDING_REQUEST_MAX_BYTES) throw new FindingClientError('finding_request_too_large');
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof FindingClientError) throw error;
    throw new FindingClientError('finding_input_unavailable');
  }
  let request: FindingRequests[FindingCommand];
  try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new FindingClientError('finding_invalid_json'); }
  return client.request(command, request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await runFindingCli(process.argv.slice(2)))}\n`); }
  catch (error) {
    const failure = error instanceof FindingClientError ? error : new FindingClientError('finding_client_failed');
    process.stdout.write(`${JSON.stringify({ success: false, code: failure.code, ...(failure.status ? { status: failure.status } : {}) })}\n`);
    process.exitCode = 1;
  }
}
