/** Isolated integration fixture, never a production engine or fallback. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { StateKV } from '../src/state/kv.js';
import { registerActionsFunction } from '../src/functions/actions.js';
import { registerWorkAuthorityFunction } from '../src/functions/work-authority.js';

const root = fs.realpathSync(process.argv[2] || '');
const marker = JSON.parse(fs.readFileSync(path.join(root, 'authority-fixture.json'), 'utf8'));
if (marker.purpose !== 'isolated-work-authority-test' || marker.root !== root) throw new Error('fixture_marker_required');
const stateFile = path.join(root, 'engine-fixture.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const functions = new Map<string, (data: any) => Promise<any>>();
const sdk = {
  registerFunction(name: string, handler: (data: any) => Promise<any>) { functions.set(name, handler); },
  async trigger(input: { function_id: string; payload: any }): Promise<any> {
    const { function_id: name, payload: p } = input;
    if (!name.startsWith('state::')) return functions.get(name)!(p);
    if (name === 'state::list_groups') return { groups: Object.keys(state) };
    if (name === 'state::get') return structuredClone(state[p.scope]?.[p.key]);
    if (name === 'state::list') return structuredClone(Object.values(state[p.scope] || {}));
    if (name === 'state::set') { state[p.scope] ||= {}; state[p.scope][p.key] = structuredClone(p.value); }
    else if (name === 'state::delete') delete state[p.scope]?.[p.key];
    else throw new Error('fixture_operation_not_supported');
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(stateFile + '.tmp', stateFile);
    return p.value;
  },
};
const kv = new StateKV(sdk as never);
registerActionsFunction(sdk as never, kv);
registerWorkAuthorityFunction(sdk as never, kv);
const projectId = 'agent-workspace-config';
if (!fs.existsSync(path.join(root, 'source-ids.json'))) {
  const rows = [];
  for (const title of ['Synthetic digest dedupe', 'Synthetic blocker dedupe', 'Historical triage']) {
    const result = await sdk.trigger({ function_id: 'mem::action-create', payload: { projectId, title, actor: 'fixture' } });
    if (!result.success) throw new Error('fixture_create_failed');
    rows.push({ id: result.action.id, revision: result.action.revision, title });
  }
  fs.writeFileSync(path.join(root, 'source-ids.json'), JSON.stringify(rows));
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, 'http://127.0.0.1');
    let data = '';
    for await (const chunk of req) {
      data += chunk;
      if (data.length > 200_000) throw new Error('fixture_request_too_large');
    }
    let result;
    if (url.pathname === '/agentmemory/work-authority') {
      result = await sdk.trigger({ function_id: req.method === 'GET' ? 'mem::work-authority-get' : 'mem::work-authority-transition',
        payload: req.method === 'GET' ? { projectId: url.searchParams.get('projectId'), includeSnapshot: url.searchParams.get('includeSnapshot') === 'true' } : JSON.parse(data) });
    } else if (url.pathname === '/fixture/old-client') {
      result = await sdk.trigger({ function_id: 'mem::action-create', payload: { projectId, title: 'Must be fenced', actor: 'legacy' } });
    } else { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  } catch { res.writeHead(500).end(JSON.stringify({ success: false, error: 'fixture_failure' })); }
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address() as { port: number };
  fs.writeFileSync(path.join(root, 'endpoint.json'), JSON.stringify({ url: `http://127.0.0.1:${address.port}` }));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
