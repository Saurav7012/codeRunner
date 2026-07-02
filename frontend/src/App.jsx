import { useState, useRef, useEffect, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import './App.css';

const LANGUAGES = [
  { id: 'python', label: 'Python', mono: 'Py', bg: '#3776AB', fg: '#FFFFFF' },
  { id: 'c', label: 'C', mono: 'C', bg: '#5C6BC0', fg: '#FFFFFF' },
  { id: 'cpp', label: 'C++', mono: 'C++', bg: '#00599C', fg: '#FFFFFF' },
  { id: 'java', label: 'Java', mono: 'J', bg: '#F58219', fg: '#FFFFFF' },
  { id: 'javascript', label: 'JavaScript', mono: 'JS', bg: '#F7DF1E', fg: '#1A1A1A' },
];

const MONACO_LANGUAGE = {
  python: 'python',
  c: 'c',
  cpp: 'cpp',
  java: 'java',
  javascript: 'javascript',
};

// Mirrors the filenames the backend actually writes to disk per language
// (see LANGUAGE_CONFIG in dockerRunner.js) — shown in the file bar above
// the editor so the UI reflects what's really being compiled/run.
const FILENAME = {
  python: 'main.py',
  c: 'main.c',
  cpp: 'main.cpp',
  java: 'Main.java',
  javascript: 'main.js',
};

const DEFAULT_CODE = {
  python: 'print("hello world")\n',
  c: '#include <stdio.h>\n\nint main() {\n    printf("hello world\\n");\n    return 0;\n}\n',
  cpp: '#include <iostream>\n\nint main() {\n    std::cout << "hello world" << std::endl;\n    return 0;\n}\n',
  java: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("hello world");\n    }\n}\n',
  javascript: 'console.log("hello world");\n',
};

const MIN_CONSOLE_HEIGHT = 140;
const RESERVED_TOP_SPACE = 220; // topbar + filebar + minimum editor room

function App() {
  const [language, setLanguage] = useState('python');
  const [code, setCode] = useState(DEFAULT_CODE.python);
  const [stdin, setStdin] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('output');
  const [consoleHeight, setConsoleHeight] = useState(260);
  const [isDragging, setIsDragging] = useState(false);

  const draggingRef = useRef(false);

  const handleLanguageChange = (newLang) => {
    setLanguage(newLang);
    // Only swap in starter code if the editor still holds an untouched
    // default — avoids clobbering in-progress work on a dropdown click.
    if (Object.values(DEFAULT_CODE).includes(code)) {
      setCode(DEFAULT_CODE[newLang]);
    }
  };

  const handleRun = useCallback(async () => {
    setLoading(true);
    setError('');
    setResult(null);
    setTab('output');

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
  }, [language, code, stdin]);

  // Ctrl/Cmd + Enter runs the current code, matching the convention used
  // by most IDEs and online judges.
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!loading && code.trim()) handleRun();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleRun, loading, code]);

  // Drag-to-resize for the console panel, anchored to the bottom of the
  // viewport (the console is always the last flex child, flush to the
  // bottom edge), so window.innerHeight - clientY gives the new height.
  useEffect(() => {
    const handleMove = (e) => {
      if (!draggingRef.current) return;
      const newHeight = window.innerHeight - e.clientY;
      const max = window.innerHeight - RESERVED_TOP_SPACE;
      setConsoleHeight(Math.min(Math.max(newHeight, MIN_CONSOLE_HEIGHT), max));
    };
    const handleUp = () => {
      draggingRef.current = false;
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  const startDrag = () => {
    draggingRef.current = true;
    setIsDragging(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  const handleEditorWillMount = (monaco) => {
    monaco.editor.defineTheme('coderunner-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0d1119',
        'editor.foreground': '#e8ebf1',
        'editorLineNumber.foreground': '#3a4354',
        'editorLineNumber.activeForeground': '#8a94a6',
        'editor.selectionBackground': '#243040',
        'editorCursor.foreground': '#5eead4',
        'editor.lineHighlightBackground': '#12161f',
        'editorGutter.background': '#0d1119',
      },
    });
  };

  const status = getStatus(loading, result, error);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">&gt;_</span>
          <span className="brand-name">codeRunner</span>
        </div>

        <div className="topbar-center">
          <button className="run-btn" onClick={handleRun} disabled={loading || !code.trim()}>
            {loading ? <SpinnerIcon /> : <PlayIcon />}
            {loading ? 'Running' : 'Run'}
          </button>
          <span className="kbd-hint">Ctrl + Enter</span>
        </div>

        <div className="topbar-spacer" />

        <div className="status-pill" style={{ color: status.color }}>
          <span className={`status-dot ${status.pulse ? 'pulse' : ''}`} />
          <span>{status.label}</span>
        </div>
      </header>

      <div className="workspace">
        <nav className="lang-rail" aria-label="Language selector">
          <span className="lang-rail-label">Language</span>
          {LANGUAGES.map((lang) => (
            <button
              key={lang.id}
              className={`lang-tile ${language === lang.id ? 'active' : ''}`}
              onClick={() => handleLanguageChange(lang.id)}
              title={lang.label}
            >
              <span className="lang-mono" style={{ background: lang.bg, color: lang.fg }}>
                {lang.mono}
              </span>
              <span className="lang-name">{lang.label}</span>
            </button>
          ))}
        </nav>

        <div className="editor-column">
          <div className="editor-filebar">{FILENAME[language]}</div>

          <div className="editor-wrap">
            <div className="editor-inner">
              <Editor
                height="100%"
                width="100%"
                language={MONACO_LANGUAGE[language]}
                value={code}
                onChange={(value) => setCode(value ?? '')}
                theme="coderunner-dark"
                beforeMount={handleEditorWillMount}
                options={{
                  fontSize: 14,
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 4,
                  padding: { top: 14 },
                }}
              />
            </div>
          </div>

          <div className={`resizer ${isDragging ? 'dragging' : ''}`} onMouseDown={startDrag} />

          <div className="console-panel" style={{ height: consoleHeight }}>
            <div className="console-tabs">
              <button
                className={`console-tab ${tab === 'output' ? 'active' : ''}`}
                onClick={() => setTab('output')}
              >
                Output
              </button>
              <button
                className={`console-tab ${tab === 'input' ? 'active' : ''}`}
                onClick={() => setTab('input')}
              >
                Input (stdin)
              </button>

              {result && (
                <div className="console-meta">
                  <span className="console-meta-badge" style={{ color: status.color, background: status.soft }}>
                    {status.label}
                  </span>
                  <span>exit {result.exitCode === null ? 'n/a' : result.exitCode}</span>
                  {result.compileTime !== undefined && <span>compile {result.compileTime}ms</span>}
                  <span>{result.phase === 'compile' ? 'compile' : 'run'} {result.executionTime}ms</span>
                </div>
              )}
            </div>

            <div className="console-body">
              {tab === 'output' ? (
                <OutputBody result={result} error={error} loading={loading} />
              ) : (
                <textarea
                  className="stdin-textarea"
                  placeholder="Program input, fed to stdin when your code runs..."
                  value={stdin}
                  onChange={(e) => setStdin(e.target.value)}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function getStatus(loading, result, error) {
  if (loading) return { label: 'Running', color: 'var(--accent)', soft: 'var(--accent-soft)', pulse: true };
  if (error) return { label: 'Connection error', color: 'var(--error)', soft: 'var(--error-soft)' };
  if (!result) return { label: 'Idle', color: 'var(--text-muted)', soft: 'transparent' };
  if (result.phase === 'compile') return { label: 'Compile error', color: 'var(--error)', soft: 'var(--error-soft)' };
  if (result.timedOut) return { label: 'Timed out', color: 'var(--warning)', soft: 'var(--warning-soft)' };
  if (result.oomKilled) return { label: 'Out of memory', color: 'var(--warning)', soft: 'var(--warning-soft)' };
  if (result.exitCode !== 0) return { label: 'Runtime error', color: 'var(--error)', soft: 'var(--error-soft)' };
  return { label: 'Success', color: 'var(--success)', soft: 'var(--success-soft)' };
}

function OutputBody({ result, error, loading }) {
  if (loading) {
    return <div className="console-empty">Running your code…</div>;
  }
  if (error) {
    return (
      <div className="console-error-banner">
        <span>{error}</span>
      </div>
    );
  }
  if (!result) {
    return <div className="console-empty">Run your code (Ctrl + Enter) to see output here.</div>;
  }

  const { stdout, stderr, phase } = result;

  return (
    <>
      {stdout && (
        <>
          <div className="console-line-label console-stdout-label">stdout</div>
          <pre className="console-pre">{stdout}</pre>
        </>
      )}
      {stderr && (
        <>
          <div className="console-line-label console-stderr-label">
            {phase === 'compile' ? 'compiler output' : 'stderr'}
          </div>
          <pre className="console-pre">{stderr}</pre>
        </>
      )}
      {!stdout && !stderr && <div className="console-empty">(no output)</div>}
    </>
  );
}

function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M2.5 1.5L11 6.5L2.5 11.5V1.5Z" fill="currentColor" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="spinner" width="13" height="13" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export default App;