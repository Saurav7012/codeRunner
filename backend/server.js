const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { runInDocker } = require('./src/dockerRunner');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '1mb' })); // limit early - no huge payloads

// Languages we will eventually support - used for validation
const SUPPORTED_LANGUAGES = ['python', 'c', 'cpp', 'java', 'javascript'];

app.post('/api/run', async (req, res) => {
  const { language, code, stdin } = req.body;

  // Basic validation - this is all the logic we need for now
  if (!language || !code) {
    return res.status(400).json({
      error: 'Both "language" and "code" fields are required.',
    });
  }

  if (!SUPPORTED_LANGUAGES.includes(language)) {
    return res.status(400).json({
      error: `Unsupported language "${language}". Supported: ${SUPPORTED_LANGUAGES.join(', ')}`,
    });
  }

  // stdin is accepted but not yet wired into execution - that's Block 6.
  // Only "python" actually has a Docker runner configured right now (Block 2);
  // c/cpp/java/javascript will throw inside runInDocker until Block 4.
  try {
    const result = await runInDocker(language, code);
    return res.status(200).json(result);
  } catch (err) {
    console.error('Docker execution failed:', err);
    return res.status(500).json({
      error: 'Internal error while executing code.',
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`codeRunner backend listening on port ${PORT}`);
});