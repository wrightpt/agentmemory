import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { CloseoutGuardNative, type NativeGuard } from '../src/state/closeout-guard-native.js';

const receiver = String.raw`
import array,json,os,socket,sys
w=json.loads(sys.argv[1]); s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(2)
s.connect(w['socket']); s.sendall(w['nonce'].encode())
data,anc,_,_=s.recvmsg(1,socket.CMSG_SPACE(array.array('i').itemsize))
fds=array.array('i')
for level,kind,payload in anc:
 if level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS: fds.frombytes(payload[:len(payload)-(len(payload)%fds.itemsize)])
if data!=b'F' or len(fds)!=1:
 print('DENIED',flush=True); sys.exit(2)
s.close(); info=os.fstat(fds[0])
if str(info.st_dev)!=w['dev'] or str(info.st_ino)!=w['ino']: sys.exit(3)
print('HELD',flush=True)
sys.stdin.buffer.read()
os.close(fds[0])
`;
const dirs: string[] = [], guards: Array<{ guard: NativeGuard; uncertain?: boolean }> = [];
const children: Array<{ end(): void; closed: Promise<number | null> }> = [];
const delay = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'n-'));
  fs.chmodSync(root, 0o700); dirs.push(root);
  return { root, native: new CloseoutGuardNative(root) };
}
async function begin(native: CloseoutGuardNative, lifetime = 10_000) {
  const guard = await native.begin(new Date(Date.now() + lifetime).toISOString());
  guard.activate({ fixture: true }); guards.push({ guard }); return guard;
}
function receive(guard: NativeGuard, nonce = guard.lock.nonce) {
  const child = spawn('/usr/bin/python3', ['-I', '-c', receiver, JSON.stringify({ ...guard.lock, nonce })], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  const ready = new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', chunk => resolve(String(chunk).trim()));
    child.once('close', () => resolve('CLOSED'));
  });
  const result = { end: () => { child.stdin.end(); }, closed, ready };
  children.push(result); return result;
}
afterEach(async () => {
  for (const child of children) child.end();
  await Promise.all(children.splice(0).map(c => c.closed));
  for (const { guard } of guards) guard.revoke();
  await Promise.all(guards.splice(0).map(({ guard, uncertain }) => uncertain ? guard.closed : guard.drained));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('private native closeout descriptor lifetime', () => {
  it('hands off the same OFD once and drains only after cooperative native ACK', async () => {
    const { native } = fixture(), guard = await begin(native);
    expect(fs.statSync(guard.liveFile).mode & 0o777).toBe(0o600);
    const holder = receive(guard); expect(await holder.ready).toBe('HELD');
    const second = receive(guard); expect(await second.ready).toBe('DENIED');
    let drained = false; void guard.drained.then(() => { drained = true; });
    guard.revoke(); await delay();
    expect(fs.existsSync(guard.liveFile)).toBe(false); expect(drained).toBe(false);
    holder.end(); await holder.closed; await guard.drained; expect(drained).toBe(true);
  });

  it('does not accept a wrong nonce or hand off before live activation', async () => {
    const { native } = fixture();
    const guard = await native.begin(new Date(Date.now() + 10_000).toISOString()); guards.push({ guard });
    expect(await receive(guard).ready).toBe('DENIED');
    guard.activate({ fixture: true });
    expect(await receive(guard, '0'.repeat(64)).ready).toBe('DENIED');
    const valid = receive(guard); expect(await valid.ready).toBe('HELD'); valid.end();
  });

  it('expiry revokes the live witness while inherited native FDs keep the drain blocked', async () => {
    const { native } = fixture(), guard = await begin(native, 180);
    const holder = receive(guard); expect(await holder.ready).toBe('HELD');
    let drained = false; void guard.drained.then(() => { drained = true; });
    await delay(230); expect(fs.existsSync(guard.liveFile)).toBe(false); expect(drained).toBe(false);
    holder.end(); await guard.drained;
  });

  it('startup waits on the original persistent inode before permitting writers', async () => {
    const { root, native } = fixture(), guard = await begin(native);
    const holder = receive(guard); expect(await holder.ready).toBe('HELD');
    const original = fs.statSync(native.file).ino;
    guard.revoke(); let initialized = false;
    const replacement = new CloseoutGuardNative(root).initialize().then(() => { initialized = true; });
    await delay(); expect(initialized).toBe(false);
    holder.end(); await Promise.all([guard.drained, replacement]);
    expect(initialized).toBe(true); expect(fs.statSync(native.file).ino).toBe(original);
  });

  it('rejects replaced, symlinked and permissive stable lock evidence', async () => {
    for (const fault of ['replaced', 'symlink', 'permissive']) {
      const { root, native } = fixture(); await native.initialize();
      fs.renameSync(native.file, native.file + '.old');
      if (fault === 'symlink') fs.symlinkSync(native.file + '.old', native.file);
      else fs.writeFileSync(native.file, '', { mode: fault === 'permissive' ? 0o644 : 0o600 });
      await expect(new CloseoutGuardNative(root).initialize()).rejects.toThrow('closeout_guard_native_unavailable');
    }
  });

  it('keeps an uncertain helper failure pending instead of claiming a successful drain', async () => {
    const { root, native } = fixture(), guard = await begin(native);
    guards[guards.length - 1].uncertain = true;
    fs.renameSync(native.file, native.file + '.old'); fs.writeFileSync(native.file, '', { mode: 0o600 });
    let drained = false; void guard.drained.then(() => { drained = true; });
    guard.revoke(); await guard.closed; expect(drained).toBe(false);
    await expect(new CloseoutGuardNative(root).initialize()).rejects.toThrow('closeout_guard_native_unavailable');
  });
});
