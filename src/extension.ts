import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as crypto from 'crypto';

let panel: vscode.WebviewPanel | undefined;
let pythonProcess: ChildProcessWithoutNullStreams | undefined;
let stdoutBuffer = '';
let pythonReady  = false;
let activeDevice = 'cpu';
let isRecording = false;
let isTranscribing = false;
let daemonDiedUnexpectedly = false;

export function activate(context: vscode.ExtensionContext) {
  checkForUpdates(context);

  // Preload: spawn the Python daemon at activation so the model loads in the background
  spawnPythonDaemon(context);

  const disposable = vscode.commands.registerCommand('whisper-dictation.toggle', () => {
    if (panel) {
      panel.reveal();
      return;
    }

    panel = vscode.window.createWebviewPanel(
      'whisperDictation',
      '🎤 Voice Dictation',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );

    const nonce = crypto.randomBytes(16).toString('hex');
    const config = vscode.workspace.getConfiguration('whisper-dictation');
    const maxSeconds = config.get<number>('maxRecordingSeconds', 300);
    panel.webview.html = getWebviewContent(nonce, maxSeconds);
    vscode.commands.executeCommand('setContext', 'whisperDictation.panelVisible', true);

    panel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'start') {
        startRecording();
      } else if (message.type === 'stop') {
        stopRecording();
      }
    });

    // Don't kill the daemon when panel closes — keep it alive for reuse
    panel.onDidDispose(() => {
      panel = undefined;
      isRecording = false;
      isTranscribing = false;
      vscode.commands.executeCommand('setContext', 'whisperDictation.panelVisible', false);
    });

    // If daemon died while panel was closed, respawn it now
    if (daemonDiedUnexpectedly || !pythonProcess) {
      daemonDiedUnexpectedly = false;
      spawnPythonDaemon(context);
    } else if (isRecording) {
      panel.webview.postMessage({ type: 'state', state: 'RECORDING' });
    } else {
      // Send current state to the newly opened panel
      panel.webview.postMessage({
        type: 'state',
        state: pythonReady ? 'READY' : 'LOADING',
        text: pythonReady ? activeDevice : undefined
      });
    }
  });

  context.subscriptions.push(disposable);

  const toggleRecording = vscode.commands.registerCommand('whisper-dictation.toggleRecording', () => {
    if (!panel) return;
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  context.subscriptions.push(toggleRecording);
}

function spawnPythonDaemon(context: vscode.ExtensionContext) {
  if (pythonProcess) return; // already running

  const scriptPath = path.join(context.extensionPath, 'src', 'record_transcribe.py');
  const cacheDir = path.join(context.globalStorageUri.fsPath, 'models');
  fs.mkdirSync(cacheDir, { recursive: true });

  const uvPath = findUv();
  if (!uvPath) {
    vscode.window.showErrorMessage('"uv" not found. Install it from https://docs.astral.sh/uv/');
    panel?.webview.postMessage({ type: 'state', state: 'DEAD' });
    return;
  }

  // Fix 1: Read model and language from VS Code settings
  const config = vscode.workspace.getConfiguration('whisper-dictation');
  const model = config.get<string>('model', 'small');
  const lang = config.get<string>('language', 'es');
  const device = config.get<string>('device', 'auto');
  const maxSeconds = config.get<number>('maxRecordingSeconds', 300);

  stdoutBuffer = '';
  pythonReady  = false;
  daemonDiedUnexpectedly = false;

  pythonProcess = spawn(
    uvPath,
    ['run', '--with', 'sounddevice', '--with', 'numpy', '--with', 'faster-whisper',
     'python', scriptPath, model, lang, cacheDir, device, String(maxSeconds)],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  ) as ChildProcessWithoutNullStreams;

  pythonProcess.stdout.on('data', (data: Buffer) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) handlePythonLine(trimmed);
    }
  });

  pythonProcess.stderr.on('data', (_data: Buffer) => {
    // stderr is for uv/Python internal logs; ignore unless debugging
  });

  pythonProcess.on('close', (_code: number | null) => {
    pythonProcess = undefined;
    pythonReady   = false;
    isRecording   = false;
    isTranscribing = false;
    daemonDiedUnexpectedly = true;
    panel?.webview.postMessage({ type: 'state', state: 'DEAD' });
  });

  pythonProcess.on('error', (err: Error) => {
    vscode.window.showErrorMessage(`Failed to start Python: ${err.message}`);
    panel?.webview.postMessage({ type: 'state', state: 'DEAD' });
    pythonProcess = undefined;
    isRecording = false;
    isTranscribing = false;
    daemonDiedUnexpectedly = true;
  });
}

function handlePythonLine(line: string) {
  if (line === 'LOADING') {
    panel?.webview.postMessage({ type: 'state', state: 'LOADING' });
  } else if (line === 'DOWNLOADING') {
    panel?.webview.postMessage({ type: 'state', state: 'DOWNLOADING' });
  } else if (line.startsWith('READY')) {
    pythonReady = true;
    activeDevice = line.includes(':') ? line.split(':')[1] : 'cpu';
    panel?.webview.postMessage({ type: 'state', state: 'READY', text: activeDevice });
  } else if (line === 'RECORDING') {
    panel?.webview.postMessage({ type: 'state', state: 'RECORDING' });
  } else if (line.startsWith('RESULT:')) {
    isRecording = false;
    isTranscribing = false;
    const text = line.slice('RESULT:'.length);
    vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`✓ Copied: "${text}"`);
    panel?.webview.postMessage({ type: 'result', text });
  } else if (line.startsWith('ERROR:')) {
    isRecording = false;
    isTranscribing = false;
    const msg = line.slice('ERROR:'.length);
    vscode.window.showErrorMessage(`Error: ${msg}`);
    panel?.webview.postMessage({ type: 'state', state: 'ERROR', text: msg });
    setTimeout(() => {
      if (pythonReady) {
        panel?.webview.postMessage({ type: 'state', state: 'READY' });
      }
    }, 3000);
  }
}

function startRecording() {
  if (!pythonProcess || !pythonReady) {
    vscode.window.showWarningMessage('The model is still loading. Please wait a moment.');
    return;
  }
  if (isTranscribing) return;
  try {
    pythonProcess.stdin.write('START\n');
    isRecording = true;
  } catch {
    // process already terminated
  }
}

function stopRecording() {
  if (!pythonProcess) return;
  try {
    pythonProcess.stdin.write('STOP\n');
    isRecording = false;
    isTranscribing = true;
    panel?.webview.postMessage({ type: 'state', state: 'TRANSCRIBING' });
  } catch {
    // Fix 4: If stdin.write throws, the process is dead — show READY or DEAD, not TRANSCRIBING
    isRecording = false;
    isTranscribing = false;
    panel?.webview.postMessage({ type: 'state', state: 'DEAD' });
  }
}

function killPythonProcess() {
  if (pythonProcess) {
    try { pythonProcess.kill(); } catch { /* ignore */ }
    pythonProcess = undefined;
    pythonReady   = false;
  }
}

function findUv(): string | undefined {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'uv.exe'),
    path.join(os.homedir(), '.local', 'bin', 'uv'),
    path.join(os.homedir(), 'AppData', 'Local', 'uv', 'uv.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const which = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(which, ['uv'], { encoding: 'utf8' });
  if (result.status === 0 && result.stdout) {
    return result.stdout.trim().split('\n')[0].trim();
  }
  return undefined;
}

function getWebviewContent(nonce: string, maxSeconds: number): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Voice Dictation</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      min-height: 100vh;
      overflow-y: auto;
      gap: 14px;
      padding: 32px 20px 24px;
    }
    #btn {
      width: 96px;
      height: 96px;
      border-radius: 50%;
      border: none;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      transition: box-shadow 0.15s, transform 0.1s, background 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 10px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.12);
      flex-shrink: 0;
    }
    #btn:not(:disabled):hover {
      outline: 3px solid var(--vscode-button-background);
      outline-offset: 4px;
    }
    #btn:not(:disabled):active {
      transform: scale(0.95);
      box-shadow: 0 1px 4px rgba(0,0,0,0.3);
    }
    #btn:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
    #btn.recording {
      background: #c0392b;
      animation: pulse 1.2s ease-in-out infinite;
    }
    #btn.recording:not(:disabled):hover { outline-color: #c0392b; }
    #btn.loading { cursor: not-allowed; opacity: 0.6; box-shadow: none; outline: none; }
    #btn.loading svg circle { animation: spin 1.2s linear infinite; transform-origin: 12px 12px; }
    @keyframes pulse {
      0%, 100% { transform: scale(1); box-shadow: 0 2px 10px rgba(0,0,0,0.35); }
      50% { transform: scale(1.06); box-shadow: 0 4px 18px rgba(192,57,43,0.55); }
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    #btn-hint {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.7;
      text-align: center;
      min-height: 1.4em;
    }
    #status {
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      transition: color 0.3s;
    }
    #status.success { color: #4caf50; }
    #status.error { color: var(--vscode-errorForeground, #f44336); }
    #result {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.1));
      border-radius: 6px;
      padding: 12px;
      width: 100%;
      max-width: 400px;
      min-height: 64px;
      max-height: 200px;
      overflow-y: auto;
      font-size: 14px;
      line-height: 1.6;
      word-break: break-word;
      flex-shrink: 0;
      scrollbar-width: thin;
      scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
    }
    #result::-webkit-scrollbar { width: 6px; }
    #result::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 3px;
    }
    #result::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
    #result.empty::before {
      content: 'Your transcription will appear here...';
      color: var(--vscode-descriptionForeground);
      opacity: 0.5;
      font-style: italic;
    }
    #hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.5;
      text-align: center;
      line-height: 1.8;
    }
  </style>
</head>
<body>
  <button id="btn" class="loading" disabled title="Loading model...">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" width="36" height="36">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="40 20"/>
    </svg>
  </button>
  <div id="btn-hint"></div>
  <div id="status">Loading model...</div>
  <div id="result" class="empty"></div>
  <div id="hint">Text is automatically copied to the clipboard.<br>Paste with Ctrl+V wherever you need it.<br>Hold Space to push-to-talk &middot; Ctrl+Shift+R to toggle from anywhere</div>

  <script nonce="${nonce}">
    const vscode   = acquireVsCodeApi();
    const btn      = document.getElementById('btn');
    const btnHint  = document.getElementById('btn-hint');
    const status   = document.getElementById('status');
    const result   = document.getElementById('result');

    let currentState = 'LOADING';
    const maxSeconds = ${maxSeconds};
    let recordingTimer = null;
    let recordingStart = 0;

    const ICON_MIC =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="36" height="36">' +
      '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>' +
      '<path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>' +
      '</svg>';

    const ICON_STOP =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="36" height="36">' +
      '<rect x="6" y="6" width="12" height="12" rx="2"/>' +
      '</svg>';

    const ICON_SPINNER =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" width="36" height="36">' +
      '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="40 20"/>' +
      '</svg>';

    const ICON_WARNING =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="36" height="36">' +
      '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>' +
      '</svg>';

    function fmtTime(s) {
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return m + ':' + String(sec).padStart(2, '0');
    }

    function stopTimer() {
      if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
    }

    function setStatus(text, cls) {
      status.textContent = text;
      status.className = cls || '';
    }

    function setResult(text) {
      result.textContent = text;
      result.classList.toggle('empty', !text);
    }

    // States: DOWNLOADING | LOADING | READY | RECORDING | TRANSCRIBING | ERROR | DEAD
    function setUiState(state, text) {
      currentState = state;
      if (state !== 'RECORDING') stopTimer();
      btn.classList.remove('recording', 'loading');
      btn.title = '';
      btnHint.textContent = '';
      switch (state) {
        case 'DOWNLOADING':
          btn.disabled = true;
          btn.classList.add('loading');
          btn.innerHTML = ICON_SPINNER;
          btn.title = 'Downloading model...';
          setStatus('Downloading model (first time only)...');
          break;
        case 'LOADING':
          btn.disabled = true;
          btn.classList.add('loading');
          btn.innerHTML = ICON_SPINNER;
          btn.title = 'Loading model...';
          setStatus('Loading model...');
          break;
        case 'READY': {
          btn.disabled = false;
          btn.innerHTML = ICON_MIC;
          btn.title = 'Click to record';
          btnHint.textContent = 'Click to record \u00b7 Hold Space';
          const deviceLabel = text === 'cuda' ? 'GPU' : 'CPU';
          setStatus('Ready (' + deviceLabel + ')');
          break;
        }
        case 'RECORDING':
          btn.disabled = false;
          btn.classList.add('recording');
          btn.innerHTML = ICON_STOP;
          btn.title = 'Click to stop';
          btnHint.textContent = 'Release Space or click to stop';
          recordingStart = Date.now();
          setStatus('Recording... 0:00 / ' + fmtTime(maxSeconds));
          recordingTimer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - recordingStart) / 1000);
            setStatus('Recording... ' + fmtTime(elapsed) + ' / ' + fmtTime(maxSeconds));
          }, 1000);
          break;
        case 'TRANSCRIBING':
          btn.disabled = true;
          btn.classList.add('loading');
          btn.innerHTML = ICON_SPINNER;
          btn.title = 'Transcribing...';
          setStatus('Transcribing...');
          break;
        case 'ERROR':
          btn.disabled = true;
          btn.innerHTML = ICON_WARNING;
          setStatus(text ? ('\u2717 ' + text) : '\u2717 Error', 'error');
          break;
        case 'DEAD':
          btn.disabled = true;
          btn.innerHTML = ICON_WARNING;
          setStatus('Process terminated. Close and reopen the panel.', 'error');
          break;
      }
    }

    btn.addEventListener('click', () => {
      if (btn.classList.contains('recording')) {
        vscode.postMessage({ type: 'stop' });
        setUiState('TRANSCRIBING');
      } else {
        setResult('');
        vscode.postMessage({ type: 'start' });
      }
    });

    // Push-to-talk: hold Space to record, release to stop
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || e.repeat) return;
      if (currentState !== 'READY') return;
      e.preventDefault();
      setResult('');
      vscode.postMessage({ type: 'start' });
    });

    document.addEventListener('keyup', (e) => {
      if (e.code !== 'Space') return;
      if (currentState !== 'RECORDING') return;
      e.preventDefault();
      vscode.postMessage({ type: 'stop' });
      setUiState('TRANSCRIBING');
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'state') {
        setUiState(msg.state, msg.text);
      } else if (msg.type === 'result') {
        setUiState('READY');
        setStatus('\u2713 Copied to clipboard', 'success');
        setResult(msg.text);
      }
    });
  </script>
</body>
</html>`;
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const LAST_UPDATE_CHECK_KEY = 'whisper-dictation.lastUpdateCheck';

function checkForUpdates(context: vscode.ExtensionContext) {
  try {
    // Fix 5: Throttle — skip if checked less than 24 hours ago
    const lastCheck = context.globalState.get<number>(LAST_UPDATE_CHECK_KEY, 0);
    if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
    context.globalState.update(LAST_UPDATE_CHECK_KEY, Date.now());

    const currentVersion: string = context.extension.packageJSON.version;

    const options = {
      hostname: 'api.github.com',
      path: '/repos/mleonmendiola-ionos/vscode-whisper-dictation/releases/latest',
      headers: { 'User-Agent': 'vscode-whisper-dictation' }
    };

    https.get(options, (res) => {
      if (res.statusCode !== 200) { res.resume(); return; }

      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try {
          const release = JSON.parse(body);
          const remoteTag: string = release.tag_name ?? '';
          const remoteVersion = remoteTag.replace(/^v/, '');

          if (!isNewer(remoteVersion, currentVersion)) return;

          const vsixAsset = (release.assets as Array<{ name: string; browser_download_url: string }>)
            ?.find((a) => a.name.endsWith('.vsix'));
          if (!vsixAsset) return;

          vscode.window
            .showInformationMessage(
              `Voice Dictation v${remoteVersion} is available. Update?`,
              'Update'
            )
            .then((choice) => {
              if (choice !== 'Update') return;
              downloadAndInstall(vsixAsset.browser_download_url, vsixAsset.name);
            });
        } catch {
          // ignore parse errors
        }
      });
    }).on('error', () => {
      // fail silently — offline or API unreachable
    });
  } catch {
    // fail silently
  }
}

function isNewer(remote: string, local: string): boolean {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rp = r[i] ?? 0;
    const lp = l[i] ?? 0;
    if (rp > lp) return true;
    if (rp < lp) return false;
  }
  return false;
}

function downloadAndInstall(url: string, filename: string, maxRedirects = 5) {
  const tmpDir = os.tmpdir();
  const dest = path.join(tmpDir, filename);
  const file = fs.createWriteStream(dest);

  const get = (targetUrl: string, redirectsLeft: number) => {
    https.get(targetUrl, { headers: { 'User-Agent': 'vscode-whisper-dictation' } }, (res) => {
      // Fix 2: Follow redirects with a limit
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          file.close();
          vscode.window.showErrorMessage('Failed to download update: too many redirects.');
          return;
        }
        get(res.headers.location, redirectsLeft - 1);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        file.close();
        vscode.window.showErrorMessage('Failed to download update.');
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        vscode.commands
          .executeCommand('workbench.extensions.installExtension', vscode.Uri.file(dest))
          .then(() => {
            // Fix 3: Clean up temp .vsix after install
            fs.unlink(dest, () => {});
            vscode.window
              .showInformationMessage('Updated! Reload VS Code to apply.', 'Reload')
              .then((choice) => {
                if (choice === 'Reload') {
                  vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
              });
          }, (err: Error) => {
            fs.unlink(dest, () => {});
            vscode.window.showErrorMessage(`Failed to install update: ${err.message}`);
          });
      });
    }).on('error', () => {
      file.close();
      vscode.window.showErrorMessage('Failed to download update.');
    });
  };

  get(url, maxRedirects);
}

export function deactivate() {
  killPythonProcess();
}
