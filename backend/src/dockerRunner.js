const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const LANGUAGE_CONFIG = {
  python: {
    image: 'coderunner-python',
    filename: 'main.py',
    buildCommand: (file) => ['python3', file],
  },
  javascript: {
    image: 'coderunner-javascript',
    filename: 'main.js',
    buildCommand: (file) => ['node', file],
  },
  c: {
    image: 'coderunner-c',
    filename: 'main.c',
    compiled: true,
    compileCommand: (file, dir) => ['gcc', file, '-O2', '-o', `${dir}/a.out`],
    runCommand: (dir) => [`${dir}/a.out`],
  },
  cpp: {
    image: 'coderunner-cpp',
    filename: 'main.cpp',
    compiled: true,
    compileCommand: (file, dir) => ['g++', file, '-O2', '-o', `${dir}/a.out`],
    runCommand: (dir) => [`${dir}/a.out`],
  },
  java: {
    image: 'coderunner-java',
    filename: 'Main.java',
    compiled: true,
    compileCommand: (file, dir) => ['javac', file, '-d', dir],
    runCommand: (dir) => ['java', '-cp', dir, 'Main'],
  },
};

const RUN_TIMEOUT_MS = 10_000;
const COMPILE_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_CHARS = 200_000;

const RUN_LIMITS = {
  memory: '128m',
  memorySwap: '128m',
  cpus: '0.5',
  pidsLimit: '64',
};

const COMPILE_LIMITS = {
  memory: '256m',
  memorySwap: '256m',
  cpus: '1.0',
  pidsLimit: '128',
};

const OOM_EXIT_CODE = 137;

/**
 * Runs user-submitted code for a given language inside Docker.
 * `stdin` is an optional string fed to the program's standard input.
 *
 * Returns:
 *  { phase: 'compile', stdout, stderr, exitCode, executionTime, timedOut, oomKilled }
 *  or
 *  { phase: 'run', stdout, stderr, exitCode, executionTime, timedOut, oomKilled, compileTime? }
 */
async function runInDocker(language, code, stdin = '') {
  const config = LANGUAGE_CONFIG[language];
  if (!config) {
    throw new Error(`No Docker runner configured for language: ${language}`);
  }

  const requestId = crypto.randomUUID();
  const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coderunner-'));
  const hostFilePath = path.join(hostDir, config.filename);
  await fs.writeFile(hostFilePath, code, 'utf8');

  const containerDir = '/code';
  const containerFilePath = `${containerDir}/${config.filename}`;

  try {
    if (config.compiled) {
      return await runCompiled(config, hostDir, containerFilePath, containerDir, requestId, stdin);
    }
    return await runInterpreted(config, hostDir, containerFilePath, requestId, stdin);
  } finally {
    await fs.rm(hostDir, { recursive: true, force: true });
  }
}

async function runInterpreted(config, hostDir, containerFilePath, requestId, stdin) {
  const containerName = `coderunner-${requestId}-run`;
  const args = buildDockerArgs({
    containerName,
    image: config.image,
    hostDir,
    containerDir: '/code',
    command: config.buildCommand(containerFilePath),
    limits: RUN_LIMITS,
    readOnlyMount: true,
    readOnlyRoot: true,
    withStdin: true, // always open stdin pipe on run containers
  });

  const startTime = Date.now();
  const result = await spawnWithTimeout('docker', args, containerName, RUN_TIMEOUT_MS, stdin);

  return {
    phase: 'run',
    ...result,
    executionTime: Date.now() - startTime,
  };
}

async function runCompiled(config, hostDir, containerFilePath, containerDir, requestId, stdin) {
  // --- Compile phase (no stdin) ---
  const compileContainerName = `coderunner-${requestId}-compile`;
  const compileArgs = buildDockerArgs({
    containerName: compileContainerName,
    image: config.image,
    hostDir,
    containerDir,
    command: config.compileCommand(containerFilePath, containerDir),
    limits: COMPILE_LIMITS,
    readOnlyMount: false,
    readOnlyRoot: false,
    withStdin: false, // compilers don't read stdin
  });

  const compileStart = Date.now();
  const compileResult = await spawnWithTimeout(
    'docker', compileArgs, compileContainerName, COMPILE_TIMEOUT_MS, ''
  );
  const compileTime = Date.now() - compileStart;

  if (compileResult.timedOut || compileResult.exitCode !== 0) {
    return {
      phase: 'compile',
      ...compileResult,
      executionTime: compileTime,
    };
  }

  // --- Run phase (with stdin) ---
  const runContainerName = `coderunner-${requestId}-run`;
  const runArgs = buildDockerArgs({
    containerName: runContainerName,
    image: config.image,
    hostDir,
    containerDir,
    command: config.runCommand(containerDir),
    limits: RUN_LIMITS,
    readOnlyMount: true,
    readOnlyRoot: true,
    withStdin: true,
  });

  const runStart = Date.now();
  const runResult = await spawnWithTimeout('docker', runArgs, runContainerName, RUN_TIMEOUT_MS, stdin);
  return {
    phase: 'run',
    ...runResult,
    executionTime: Date.now() - runStart,
    compileTime,
  };
}

/**
 * Builds the full `docker run` argv for one container invocation.
 * `withStdin: true` adds `-i` so the container's stdin stays open until
 * we close the host-side pipe in spawnWithTimeout.
 */
function buildDockerArgs({
  containerName, image, hostDir, containerDir, command, limits, readOnlyMount, readOnlyRoot, withStdin,
}) {
  const args = [
    'run',
    '--rm',
    '--name', containerName,

    '--memory', limits.memory,
    '--memory-swap', limits.memorySwap,
    '--cpus', limits.cpus,
    '--pids-limit', limits.pidsLimit,

    '--network', 'none',

    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
  ];

  if (withStdin) {
    // Keep the container's stdin pipe open so we can write to it.
    // Without -i, Docker closes the container's stdin immediately on startup.
    args.push('-i');
  }

  if (readOnlyRoot) {
    args.push('--read-only', '--tmpfs', '/tmp:rw,size=16m,noexec');
  }

  const mountFlag = readOnlyMount ? 'ro' : 'rw';
  args.push('-v', `${hostDir}:${containerDir}:${mountFlag}`);

  args.push(image, ...command);
  return args;
}

/**
 * Spawns a docker command, writes stdinData to the container's stdin then
 * closes the pipe (signaling EOF), collects stdout/stderr, and enforces a
 * timeout via `docker kill`.
 */
function spawnWithTimeout(command, args, containerName, timeoutMs, stdinData) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      spawn('docker', ['kill', containerName]).on('error', () => {});
    }, timeoutMs);

    // Write stdin data then close the pipe immediately.
    // child.stdin.end() with data is equivalent to write() + end() — it sends
    // the data and then EOF in one call. If stdinData is empty, this just
    // sends EOF, which is the correct behaviour for programs that don't read
    // from stdin (they see an immediately-closed pipe and carry on as normal).
    child.stdin.end(stdinData);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);

      const oomKilled = !timedOut && exitCode === OOM_EXIT_CODE;

      resolve({
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: timedOut
          ? stderr + '\n[Execution timed out and was terminated]'
          : oomKilled
            ? stderr + '\n[Process killed: memory limit exceeded]'
            : stderr.slice(0, MAX_OUTPUT_CHARS),
        exitCode: timedOut ? null : exitCode,
        timedOut,
        oomKilled,
      });
    });
  });
}

module.exports = { runInDocker, LANGUAGE_CONFIG, RUN_LIMITS, COMPILE_LIMITS };