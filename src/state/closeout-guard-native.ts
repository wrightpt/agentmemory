import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

export interface EffectLock {
  file: string; pid: number; fd: number; dev: string; ino: string;
  startTicks: string; socket: string; nonce: string;
}
export interface NativeGuard {
  lock: EffectLock;
  liveFile: string;
  activate(value: unknown): void;
  revoke(): void;
  drained: Promise<void>;
  closed?: Promise<void>;
}
export interface NativeGuardFactory {
  initialize(): Promise<void>;
  begin(expiresAt: string): Promise<NativeGuard>;
}
type Identity = { dev: string; ino: string };
const fail = (): never => { throw new Error('closeout_guard_native_unavailable'); };

export function processIncarnation(pid = process.pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
  if (['Z', 'X', 'x'].includes(fields[0]) || !/^\d+$/.test(fields[19] || '')) fail();
  return { pid, startTicks: fields[19], bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
}

const program = String.raw`
import array,fcntl,json,os,selectors,socket,stat,sys,time
mode,file,expected=sys.argv[1:4]
expected=json.loads(expected)
def opened(create=False):
 fd=os.open(file,os.O_RDWR|os.O_NOFOLLOW|(os.O_CREAT if create else 0),0o600)
 s=os.fstat(fd)
 identity=dict(dev=str(s.st_dev),ino=str(s.st_ino))
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=0o600 or (expected and identity!=expected):
  os.close(fd); raise RuntimeError('unsafe_effect_inode')
 return fd,identity
def unchanged(identity):
 s=os.lstat(file)
 return stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600 and dict(dev=str(s.st_dev),ino=str(s.st_ino))==identity
fd,identity=opened(mode=='drain' and not expected)
if mode=='drain':
 fcntl.flock(fd,fcntl.LOCK_EX)
 if not unchanged(identity): raise RuntimeError('replaced_effect_inode')
 os.close(fd)
 print(json.dumps(dict(event='drained',**identity)),flush=True)
 sys.exit(0)
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
endpoint,nonce,live,deadline=sys.argv[4:8]
deadline=float(deadline)
server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
server.bind(endpoint); os.chmod(endpoint,0o600); server.listen(4)
selector=selectors.DefaultSelector(); selector.register(server,selectors.EVENT_READ,'socket'); selector.register(sys.stdin,selectors.EVENT_READ,'stdin')
print(json.dumps(dict(event='ready',pid=os.getpid(),fd=fd,**identity)),flush=True)
handed=False
try:
 while time.time()<deadline:
  events=selector.select(max(0,min(0.1,deadline-time.time())))
  stop=False
  for key,_ in events:
   if key.data=='stdin':
    os.read(sys.stdin.fileno(),4096); stop=True; break
   client,_=server.accept()
   with client:
    client.settimeout(0.2)
    try:
     token=b''
     while len(token)<64:
      part=client.recv(64-len(token))
      if not part: break
      token+=part
     if token.decode()==nonce and not handed and time.time()<deadline and os.path.isfile(live) and unchanged(identity):
      handed=True
      client.sendmsg([b'F'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[fd]))])
    except (OSError,UnicodeError): pass
  if stop: break
finally:
 try: os.unlink(live)
 except FileNotFoundError: pass
 selector.close(); server.close()
# Closing our reference must not unlock duplicates held by the native bridge.
fresh,again=opened()
if again!=identity or not unchanged(identity): raise RuntimeError('replaced_effect_inode')
os.close(fd)
fcntl.flock(fresh,fcntl.LOCK_EX)
if not unchanged(identity): raise RuntimeError('replaced_effect_inode')
os.close(fresh)
print(json.dumps(dict(event='drained',**identity)),flush=True)
`;

function privateFile(file: string) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!()
      || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) fail();
}

export class CloseoutGuardNative implements NativeGuardFactory {
  private identity?: Identity;
  private initialized?: Promise<void>;
  readonly directory: string;
  readonly file: string;
  constructor(dataDir: string) {
    this.directory = path.join(dataDir, 'closeout-guard');
    this.file = path.join(this.directory, 'effect.lock');
  }

  initialize(): Promise<void> {
    return this.initialized ??= this.initializeOnce();
  }

  private async initializeOnce() {
    if (process.platform !== 'linux' || !path.isAbsolute(this.directory)) fail();
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const dir = fs.lstatSync(this.directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid!() || (dir.mode & 0o777) !== 0o700) fail();
    const identityFile = path.join(this.directory, 'effect.identity.json');
    let expected: Identity | undefined;
    try {
      privateFile(identityFile);
      expected = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      if (!expected || !/^\d+$/.test(expected.dev) || !/^\d+$/.test(expected.ino)) fail();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const identity = await this.drain(expected);
    if (!expected) fs.writeFileSync(identityFile, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
    this.identity = identity;
  }

  private drain(expected?: Identity): Promise<Identity> {
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/python3', ['-I', '-c', program, 'drain', this.file, JSON.stringify(expected || null)],
        { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', chunk => { if (output.length < 4096) output += String(chunk); });
      child.once('error', () => reject(new Error('closeout_guard_native_unavailable')));
      child.once('close', code => {
        try {
          const row = JSON.parse(output);
          if (code !== 0 || row.event !== 'drained' || !/^\d+$/.test(row.dev) || !/^\d+$/.test(row.ino)
              || (expected && (row.dev !== expected.dev || row.ino !== expected.ino))) fail();
          resolve({ dev: row.dev, ino: row.ino });
        } catch { reject(new Error('closeout_guard_native_unavailable')); }
      });
    });
  }

  async begin(expiresAt: string): Promise<NativeGuard> {
    await this.initialize();
    const identity = this.identity!;
    const dir = fs.mkdtempSync(path.join(this.directory, 'g-'));
    fs.chmodSync(dir, 0o700);
    const socket = path.join(dir, 'fd.sock'), liveFile = path.join(dir, 'live.json');
    const nonce = randomBytes(32).toString('hex');
    let readyResolve!: (guard: NativeGuard) => void, readyReject!: (error: Error) => void;
    let drainedResolve!: () => void;
    let closedResolve!: () => void;
    const ready = new Promise<NativeGuard>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const drained = new Promise<void>(resolve => { drainedResolve = resolve; });
    const closed = new Promise<void>(resolve => { closedResolve = resolve; });
    let published = false, drainSeen = false, revoked = false, buffer = '';
    const child = spawn('/usr/bin/python3', ['-I', '-c', program, 'hold', this.file, JSON.stringify(identity), socket,
      nonce, liveFile, String(Date.parse(expiresAt) / 1000)], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.on('error', () => {});
    const revoke = () => {
      revoked = true;
      try { fs.unlinkSync(liveFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
      child.stdin.end();
    };
    child.stdout.on('data', chunk => {
      buffer += String(chunk);
      if (buffer.length > 8192) { revoke(); return; }
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const row = JSON.parse(line);
          if (row.dev !== identity.dev || row.ino !== identity.ino) fail();
          if (row.event === 'ready' && !published && row.pid === child.pid && Number.isInteger(row.fd) && row.fd > 0) {
            const lock = { file: this.file, pid: row.pid, fd: row.fd, ...identity,
              startTicks: processIncarnation(row.pid).startTicks, socket, nonce };
            published = true;
            readyResolve({ lock, liveFile, drained, closed, revoke, activate(value) {
              if (revoked || Date.now() >= Date.parse(expiresAt)) fail();
              fs.writeFileSync(liveFile, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
            } });
          } else if (row.event === 'drained') drainSeen = true;
          else fail();
        } catch { revoke(); }
      }
    });
    child.once('error', () => { revoke(); });
    child.once('close', async code => {
      revoke();
      if (!published) readyReject(new Error('closeout_guard_native_unavailable'));
      try {
        if (code !== 0 || !drainSeen) await this.drain(identity);
        fs.rmSync(dir, { recursive: true, force: true });
        drainedResolve();
      } catch {
        // No timer or rejected promise may release writers on an unproven drain.
      } finally { closedResolve(); }
    });
    return ready;
  }
}
