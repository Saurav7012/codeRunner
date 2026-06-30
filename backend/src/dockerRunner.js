const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Per-language config. Block 4 will add more entries to this object —
// the runner function below is already written to be language-agnostic.
const LANGUAGE_CONFIG = {
  python: {
    image: 'coderunner-python',
    filename: 'main.py',
    // Command run *inside* the container, with {file} substituted
    // for the path the code will be mounted at.
    buildCommand: (file) => ['python3', file],
  },
};

const TIMEOUT_MS = 10_000; // 10 second hard cap for this block; tuned in Block 3
const MAX_OUTPUT_CHARS = 200_000; // crude guard against runaway output for now

/**
 * Runs user-submitted code for a given language inside a one-shot Docker container.
 * Returns { stdout, stderr, exitCode, executionTime, timedOut }.
 */
async function runInDocker(language, code) {
  const config = LANGUAGE_CONFIG[language];
  if (!config) {
    throw new Error(`No Docker runner configured for language: ${language}`);
  }

  // 1. Create an isolated temp directory on the host for this single request.
  //    Using os.tmpdir() + a random suffix avoids collisions between
  //    concurrent requests (important once multiple users hit /api/run at once).
  const requestId = crypto.randomUUID();
  const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coderunner-'));
  const hostFilePath = path.join(hostDir, config.filename);
  const containerName = `coderunner-${requestId}`;

  await fs.writeFile(hostFilePath, code, 'utf8');

  const containerFilePath = `/code/${config.filename}`;
  const innerCommand = config.buildCommand(containerFilePath);
//   innerCommand = ['python3', '/workspace/main.py']

  const dockerArgs = [
    'run',
    '--rm', // auto-remove the container's writable layer on exit
    '--name', containerName,
    '-v', `${hostFilePath}:${containerFilePath}:ro`, // bind mount, read-only
    config.image,
    ...innerCommand,
  ];

  const startTime = Date.now();

  try {
    const result = await spawnWithTimeout('docker', dockerArgs, containerName, TIMEOUT_MS);
    return {
      ...result,
      executionTime: Date.now() - startTime,
    };
  } finally {
    // Always clean up the temp dir, whether the run succeeded, failed, or timed out.
    await fs.rm(hostDir, { recursive: true, force: true });
  }
}

/**
 * Wraps spawn() in a Promise, collects stdout/stderr, and enforces a timeout
 * by issuing `docker kill` against the container name (not just killing the
 * local `docker run` CLI process, which would leave the container running).
 */
function spawnWithTimeout(command, args, containerName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // Fire-and-forget: ask the Docker daemon to kill the container by name.
      // We don't await this — the main child process will exit shortly after
      // its container is killed, which resolves this promise via the 'close' handler.
      spawn('docker', ['kill', containerName]).on('error', () => {
        // If `docker kill` itself fails (e.g. container already exited
        // between us deciding to time out and issuing the kill), that's fine.
      });
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
      resolve({
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: timedOut
          ? stderr + '\n[Execution timed out and was terminated]'
          : stderr.slice(0, MAX_OUTPUT_CHARS),
        exitCode: timedOut ? null : exitCode,
        timedOut,
      });
    });
  });
}

module.exports = { runInDocker, LANGUAGE_CONFIG };