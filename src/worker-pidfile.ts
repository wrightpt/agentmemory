import {
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface WorkerPidfileLease {
  path: string;
  pid: number;
}

type IsPidAlive = (pid: number) => boolean;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function acquireWorkerPidfile(
  path: string,
  pid = process.pid,
  isPidAlive: IsPidAlive = processIsAlive,
): WorkerPidfileLease {
  mkdirSync(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${pid}\n`, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      return { path, pid };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const existingPid = readPid(path);
      if (existingPid !== null && isPidAlive(existingPid)) {
        throw new Error(`agentmemory worker already running (pid ${existingPid})`);
      }

      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw unlinkError;
        }
      }
    }
  }

  throw new Error(`could not acquire agentmemory worker pidfile: ${path}`);
}

export function releaseWorkerPidfile(lease: WorkerPidfileLease): void {
  if (readPid(lease.path) !== lease.pid) return;
  try {
    unlinkSync(lease.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
