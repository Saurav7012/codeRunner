const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Per-language config.
//
// Two shapes:
//  - interpreted languages: { image, filename, buildCommand }
//      buildCommand(containerFilePath) -> argv array that runs the source directly
//  - compiled languages: { image, filename, compiled: true, compileCommand, runCommand }
//      compileCommand(containerFilePath, containerDir) -> argv array that builds the binary
//      runCommand(containerDir) -> argv array that executes the built artifact
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
    // MVP constraint: user code must declare `public class Main`.
    filename: 'Main.java',
    compiled: true,
    compileCommand: (file, dir) => ['javac', file, '-d', dir],
    runCommand: (dir) => ['java', '-cp', dir, 'Main'],
  },
};

const RUN_TIMEOUT_MS = 10_000;     // hard cap on the EXECUTION phase
const COMPILE_TIMEOUT_MS = 15_000; // separate, slightly more generous cap on the COMPILE phase
const MAX_OUTPUT_CHARS = 200_000;

// Resource limits applied to every container, both compile and run phases.
// Compile gets a higher pids-limit because real compilers (gcc/g++ especially)
// spawn several helper subprocesses (cc1, as, ld, ...) under the hood.
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
 * Runs user-submitted code for a given language. For interpreted languages this
 * is a single container invocation. For compiled languages this is two:
 * a compile container (writable mount, relaxed-but-still-limited resources)
 * followed by a run container (read-only mount, Block 3 hardening intact).
 *
 * Returns:
 *  { phase: 'compile', stdout, stderr, exitCode, executionTime, timedOut, oomKilled }
 *  or
 *  { phase: 'run', stdout, stderr, exitCode, executionTime, timedOut, oomKilled, compileTime? }
 */
async function runInDocker(language, code) {
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
      return await runCompiled(config, hostDir, containerFilePath, containerDir, requestId);
    }
    return await runInterpreted(config, hostDir, containerFilePath, requestId);
  } finally {
    await fs.rm(hostDir, { recursive: true, force: true });
  }
}

async function runInterpreted(config, hostDir, containerFilePath, requestId) {
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
  });

  const startTime = Date.now();
  const result = await spawnWithTimeout('docker', args, containerName, RUN_TIMEOUT_MS);
  return {
    phase: 'run',
    ...result,
    executionTime: Date.now() - startTime,
  };
}

async function runCompiled(config, hostDir, containerFilePath, containerDir, requestId) {
  // --- Compile phase ---
  const compileContainerName = `coderunner-${requestId}-compile`;
  const compileArgs = buildDockerArgs({
    containerName: compileContainerName,
    image: config.image,
    hostDir,
    containerDir,
    command: config.compileCommand(containerFilePath, containerDir),
    limits: COMPILE_LIMITS,
    readOnlyMount: false, // compiler needs to write the binary/.class files here
    readOnlyRoot: false,  // some compilers want scratch space outside /tmp too
  });

  const compileStart = Date.now();
  const compileResult = await spawnWithTimeout(
    'docker', compileArgs, compileContainerName, COMPILE_TIMEOUT_MS
  );
  const compileTime = Date.now() - compileStart;

  // If compilation failed (nonzero exit, OOM, or timeout) we stop here —
  // there's nothing to run, and the caller needs to know this was a
  // compile-time problem, not a runtime one.
  if (compileResult.timedOut || compileResult.exitCode !== 0) {
    return {
      phase: 'compile',
      ...compileResult,
      executionTime: compileTime,
    };
  }

  // --- Run phase ---
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
  });

  const runStart = Date.now();
  const runResult = await spawnWithTimeout('docker', runArgs, runContainerName, RUN_TIMEOUT_MS);
  return {
    phase: 'run',
    ...runResult,
    executionTime: Date.now() - runStart,
    compileTime,
  };
}

/**
 * Builds the full `docker run` argv for one container invocation, applying
 * the Block 3 hardening flags (network/fs/privilege) plus whichever resource
 * limits are passed in.
 */
function buildDockerArgs({
  containerName, image, hostDir, containerDir, command, limits, readOnlyMount, readOnlyRoot,
}) {
  const args = [
    'run',
    '--rm',
    '--name', containerName,

    // --- Resource limits ---
    '--memory', limits.memory,
    '--memory-swap', limits.memorySwap,
    '--cpus', limits.cpus,
    '--pids-limit', limits.pidsLimit,

    // --- Network isolation ---
    '--network', 'none',

    // --- Privilege hardening (always on, compile and run alike) ---
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
  ];

  if (readOnlyRoot) {
    args.push('--read-only', '--tmpfs', '/tmp:rw,size=16m,noexec');
  }

  const mountFlag = readOnlyMount ? 'ro' : 'rw';
  args.push('-v', `${hostDir}:${containerDir}:${mountFlag}`);

  args.push(image, ...command);
  return args;
}

function spawnWithTimeout(command, args, containerName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      spawn('docker', ['kill', containerName]).on('error', () => {});
    }, timeoutMs);

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