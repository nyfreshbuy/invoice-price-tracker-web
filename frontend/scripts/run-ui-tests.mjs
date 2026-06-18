import { spawn } from 'node:child_process';
import http from 'node:http';
import process from 'node:process';

const host = '127.0.0.1';
const port = 4173;
const baseUrl = `http://${host}:${port}`;
const isWindows = process.platform === 'win32';
const npxCmd = 'npx';
const passthroughArgs = process.argv.slice(2);

function spawnCommand(command, args, options = {}) {
  if (!isWindows) {
    return spawn(command, args, {
      shell: false,
      ...options
    });
  }
  return spawn('cmd.exe', ['/d', '/s', '/c', [command, ...args].join(' ')], {
    shell: false,
    ...options
  });
}

function waitForServer(url, timeoutMs = 60000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });
      request.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(check, 500);
      });
      request.setTimeout(3000, () => {
        request.destroy();
      });
    };
    check();
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawnCommand(command, args, {
      stdio: 'inherit',
      ...options
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function stopProcessTree(child) {
  if (!child?.pid) return;
  if (isWindows) {
    await run('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

const vite = spawnCommand(npxCmd, ['vite', '--host', host, '--port', String(port), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    VITE_API_BASE_URL: baseUrl
  }
});

vite.stdout.on('data', (chunk) => process.stdout.write(chunk));
vite.stderr.on('data', (chunk) => process.stderr.write(chunk));

let exitCode = 1;
try {
  await waitForServer(baseUrl);
  exitCode = await run(npxCmd, ['playwright', 'test', ...passthroughArgs], {
    env: {
      ...process.env,
      VITE_API_BASE_URL: baseUrl
    }
  });
} catch (error) {
  console.error(error.message || error);
  exitCode = 1;
} finally {
  await stopProcessTree(vite);
}

process.exit(exitCode);
