import { useState } from 'react';
import Editor from '@monaco-editor/react';

const LANGUAGES = ['python', 'c', 'cpp', 'java', 'javascript'];

const MONACO_LANGUAGE = {
  python: 'python',
  c: 'c',
  cpp: 'cpp',
  java: 'java',
  javascript: 'javascript',
};

const DEFAULT_CODE = {
  python: 'print("hello world")\n',
  c: '#include <stdio.h>\n\nint main() {\n    printf("hello world\\n");\n    return 0;\n}\n',
  cpp: '#include <iostream>\n\nint main() {\n    std::cout << "hello world" << std::endl;\n    return 0;\n}\n',
  java: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("hello world");\n    }\n}\n',
  javascript: 'console.log("hello world");\n',
};

function App() {
  const [language, setLanguage] = useState('python');
  const [code, setCode] = useState(DEFAULT_CODE.python);
  const [stdin, setStdin] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLanguageChange = (newLang) => {
    setLanguage(newLang);
    if (Object.values(DEFAULT_CODE).includes(code)) {
      setCode(DEFAULT_CODE[newLang]);
    }
  };

  const handleRun = async () => {
    setLoading(true);
    setError('');
    setResult(null);

    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language, code, stdin }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Something went wrong.');
      } else {
        setResult(data);
      }
    } catch (err) {
      setError('Could not reach the server. Is the backend running?');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-base-200 p-6">
      <div className="max-w-4xl mx-auto space-y-4">
        <h1 className="text-3xl font-bold">codeRunner</h1>

        <select
          className="select select-bordered w-full max-w-xs"
          value={language}
          onChange={(e) => handleLanguageChange(e.target.value)}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>{lang}</option>
          ))}
        </select>

        <div className="rounded-lg overflow-hidden border border-base-300">
          <Editor
            height="400px"
            language={MONACO_LANGUAGE[language]}
            value={code}
            onChange={(value) => setCode(value ?? '')}
            theme="vs-dark"
            options={{
              fontSize: 14,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 4,
            }}
          />
        </div>

        {/* Stdin input — always visible so users know it exists */}
        <div className="space-y-1">
          <label className="text-sm font-medium opacity-70">
            stdin <span className="opacity-50">(optional — fed to your program's standard input)</span>
          </label>
          <textarea
            className="textarea textarea-bordered w-full font-mono text-sm"
            rows={3}
            placeholder="Enter program input here..."
            value={stdin}
            onChange={(e) => setStdin(e.target.value)}
          />
        </div>

        <button
          className="btn btn-primary"
          onClick={handleRun}
          disabled={loading || !code.trim()}
        >
          {loading ? (
            <>
              <span className="loading loading-spinner"></span>
              Running...
            </>
          ) : (
            'Run'
          )}
        </button>

        {error && (
          <div className="alert alert-error">
            <span>{error}</span>
          </div>
        )}

        {result && <OutputPanel result={result} />}
      </div>
    </div>
  );
}

function OutputPanel({ result }) {
  const { phase, stdout, stderr, exitCode, executionTime, compileTime, timedOut, oomKilled } = result;

  let statusLabel = 'Success';
  let statusClass = 'badge-success';

  if (phase === 'compile') {
    statusLabel = 'Compile Error';
    statusClass = 'badge-error';
  } else if (timedOut) {
    statusLabel = 'Timed Out';
    statusClass = 'badge-warning';
  } else if (oomKilled) {
    statusLabel = 'Out of Memory';
    statusClass = 'badge-warning';
  } else if (exitCode !== 0) {
    statusLabel = 'Runtime Error';
    statusClass = 'badge-error';
  }

  return (
    <div className="bg-base-300 rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`badge ${statusClass}`}>{statusLabel}</span>
        <span className="text-sm opacity-70">exit code: {exitCode === null ? 'n/a' : exitCode}</span>
        {compileTime !== undefined && (
          <span className="text-sm opacity-70">compile: {compileTime}ms</span>
        )}
        <span className="text-sm opacity-70">
          {phase === 'compile' ? 'compile' : 'run'}: {executionTime}ms
        </span>
      </div>

      {stdout && (
        <div className="font-mono text-sm">
          <div className="text-success mb-1">stdout:</div>
          <pre className="whitespace-pre-wrap break-words bg-base-100 rounded p-2">{stdout}</pre>
        </div>
      )}

      {stderr && (
        <div className="font-mono text-sm">
          <div className="text-error mb-1">
            {phase === 'compile' ? 'compiler output:' : 'stderr:'}
          </div>
          <pre className="whitespace-pre-wrap break-words bg-base-100 rounded p-2">{stderr}</pre>
        </div>
      )}

      {!stdout && !stderr && (
        <div className="text-sm opacity-60 font-mono">(no output)</div>
      )}
    </div>
  );
}

export default App;