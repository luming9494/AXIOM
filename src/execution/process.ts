import { spawn } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  stopped: 'timeout' | 'aborted' | 'output_limit' | null;
}

// No provider credentials, PYTHONPATH, shell startup files or inherited proxy config.
export function childEnvironment(executable: string, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: [dirname(executable), ...(process.platform === 'win32' ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'])].join(delimiter),
    HOME: home, USERPROFILE: home, TEMP: home, TMP: home,
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1',
    OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1',
  };
  for (const name of ['SystemRoot', 'WINDIR']) if (process.env[name]) env[name] = process.env[name];
  return env;
}

export async function runProcess(executable: string, args: string[], options: {
  cwd: string; home: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number;
}): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd, env: childEnvironment(executable, options.home), shell: false,
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', bytes = 0;
    let stopped: ProcessResult['stopped'] = null;
    const limit = options.maxBytes ?? 64 * 1024;
    const stop = (reason: NonNullable<ProcessResult['stopped']>) => {
      if (stopped) return;
      stopped = reason;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.on('exit', code => { if (code !== 0) child.kill(); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const capture = (data: Buffer, target: 'stdout' | 'stderr') => {
      const text = data.subarray(0, Math.max(0, limit - bytes)).toString('utf8');
      if (target === 'stdout') stdout += text; else stderr += text;
      bytes += data.length;
      if (bytes > limit) stop('output_limit');
    };
    child.stdout.on('data', (data: Buffer) => capture(data, 'stdout'));
    child.stderr.on('data', (data: Buffer) => capture(data, 'stderr'));
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 60_000);
    const abort = () => stop('aborted');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => { cleanup(); resolve({ code, stdout, stderr, stopped }); });
  });
}
