const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { runInDocker } = require('./src/dockerRunner');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '1mb' })); // limit early - no huge payloads

// Languages we support - used for validation
const SUPPORTED_LANGUAGES = ['python', 'c', 'cpp', 'java', 'javascript'];

app.post('/api/run', async (req, res) => {
  const { language, code, stdin } = req.body;

  // Basic validation
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
  // As of Block 4, all 5 languages have working Docker runners.
  // runInDocker now returns a `phase` field ('compile' | 'run') for
  // compiled languages, so the caller can distinguish a compile error
  // from a runtime error. The frontend doesn't use this yet (Block 5).
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