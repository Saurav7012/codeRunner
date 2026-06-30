import { useState } from 'react';

const LANGUAGES = ['python', 'c', 'cpp', 'java', 'javascript'];

function App() {
  const [language, setLanguage] = useState('python');
  const [code, setCode] = useState('');
  const [output, setOutput] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleRun = async () => {
    setLoading(true);
    setError('');
    setOutput(null);

    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language, code }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Something went wrong.');
      } else {
        setOutput(data);
      }
    } catch (err) {
      setError('Could not reach the server. Is the backend running?');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-base-200 p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <h1 className="text-3xl font-bold">codeRunner</h1>

        <select
          className="select select-bordered w-full max-w-xs"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>{lang}</option>
          ))}
        </select>

        <textarea
          className="textarea textarea-bordered w-full h-64 font-mono"
          placeholder="Write your code here..."
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />

        <button
          className="btn btn-primary"
          onClick={handleRun}
          disabled={loading || !code.trim()}
        >
          {loading ? <span className="loading loading-spinner"></span> : 'Run'}
        </button>

        {error && (
          <div className="alert alert-error">
            <span>{error}</span>
          </div>
        )}

        {output && (
          <div className="bg-base-300 rounded-lg p-4 font-mono text-sm space-y-1">
            <div><span className="text-success">stdout:</span> {output.stdout}</div>
            <div><span className="text-error">stderr:</span> {output.stderr || '(none)'}</div>
            <div>exit code: {output.exitCode}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;