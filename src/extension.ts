import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as crypto from 'crypto';

let panel: vscode.WebviewPanel | undefined;
let pythonProcess: ChildProcessWithoutNullStreams | undefined;
let stdoutBuffer = '';
let pythonReady  = false;

export function activate(context: vscode.ExtensionContext) {
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
    panel.webview.html = getWebviewContent(nonce);

    panel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'start') {
        startRecording();
      } else if (message.type === 'stop') {
        stopRecording();
      }
    });

    panel.onDidDispose(() => {
      killPythonProcess();
      panel = undefined;
    });

    spawnPythonDaemon(context);
  });

  context.subscriptions.push(disposable);
}

function spawnPythonDaemon(context: vscode.ExtensionContext) {
  const scriptPath = path.join(context.extensionPath, 'src', 'record_transcribe.py');
  const cacheDir = path.join(context.globalStorageUri.fsPath, 'models');
  fs.mkdirSync(cacheDir, { recursive: true });

  const uvPath = findUv();
  if (!uvPath) {
    vscode.window.showErrorMessage('"uv" not found. Install it from https://docs.astral.sh/uv/');
    panel?.webview.postMessage({ type: 'state', state: 'DEAD' });
    return;
  }

  stdoutBuffer = '';
  pythonReady  = false;

  pythonProcess = spawn(
    uvPath,
    ['run', '--with', 'sounddevice', '--with', 'numpy', '--with', 'faster-whisper',
     'python', scriptPath, 'small', 'es', cacheDir],
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
    panel?.webview.postMessage({ type: 'state', state: 'DEAD' });
  });

  pythonProcess.on('error', (err: Error) => {
    vscode.window.showErrorMessage(`Failed to start Python: ${err.message}`);
    panel?.webview.postMessage({ type: 'state', state: 'DEAD' });
    pythonProcess = undefined;
  });
}

function handlePythonLine(line: string) {
  if (line === 'LOADING') {
    panel?.webview.postMessage({ type: 'state', state: 'LOADING' });
  } else if (line === 'READY') {
    pythonReady = true;
    panel?.webview.postMessage({ type: 'state', state: 'READY' });
  } else if (line === 'RECORDING') {
    panel?.webview.postMessage({ type: 'state', state: 'RECORDING' });
  } else if (line.startsWith('RESULT:')) {
    const text = line.slice('RESULT:'.length);
    vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`✓ Copied: "${text}"`);
    panel?.webview.postMessage({ type: 'result', text });
  } else if (line.startsWith('ERROR:')) {
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
  try {
    pythonProcess.stdin.write('START\n');
  } catch {
    // process already terminated
  }
}

function stopRecording() {
  if (!pythonProcess) return;
  try {
    pythonProcess.stdin.write('STOP\n');
  } catch {
    // process already terminated
  }
  panel?.webview.postMessage({ type: 'state', state: 'TRANSCRIBING' });
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

function getWebviewContent(nonce: string): string {
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
      justify-content: center;
      height: 100vh;
      gap: 20px;
      padding: 20px;
    }
    #btn {
      width: 90px;
      height: 90px;
      border-radius: 50%;
      border: 3px solid var(--vscode-button-background);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-size: 36px;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #btn:hover { opacity: 0.85; }
    #btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #btn.recording {
      background: #cc3333;
      border-color: #cc3333;
      animation: pulse 1s infinite;
    }
    #btn.loading {
      animation: spin 1.5s linear infinite;
      opacity: 0.6;
      cursor: not-allowed;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    #status {
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
    #result {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 12px;
      width: 100%;
      max-width: 380px;
      min-height: 60px;
      font-size: 14px;
      line-height: 1.5;
      word-break: break-word;
    }
    #hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.6;
      text-align: center;
    }
  </style>
</head>
<body>
  <button id="btn" disabled title="Loading model...">⏳</button>
  <div id="status">Loading model...</div>
  <div id="result"></div>
  <div id="hint">Text is automatically copied to the clipboard.<br>Paste with Ctrl+V wherever you need it.</div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const btn    = document.getElementById('btn');
    const status = document.getElementById('status');
    const result = document.getElementById('result');

    // States: LOADING | READY | RECORDING | TRANSCRIBING | ERROR | DEAD
    function setUiState(state, text) {
      btn.classList.remove('recording', 'loading');
      switch (state) {
        case 'LOADING':
          btn.disabled = true;
          btn.classList.add('loading');
          btn.textContent = '⏳';
          status.textContent = 'Loading model...';
          break;
        case 'READY':
          btn.disabled = false;
          btn.textContent = '🎤';
          status.textContent = 'Ready to record';
          break;
        case 'RECORDING':
          btn.disabled = false;
          btn.classList.add('recording');
          btn.textContent = '⏹';
          status.textContent = 'Recording...';
          break;
        case 'TRANSCRIBING':
          btn.disabled = true;
          btn.textContent = '⏳';
          status.textContent = 'Transcribing...';
          break;
        case 'ERROR':
          btn.disabled = true;
          btn.textContent = '⚠️';
          status.textContent = text ? ('✗ ' + text) : '✗ Error';
          break;
        case 'DEAD':
          btn.disabled = true;
          btn.textContent = '⚠️';
          status.textContent = 'Process terminated. Close and reopen the panel.';
          break;
      }
    }

    btn.addEventListener('click', () => {
      if (btn.classList.contains('recording')) {
        vscode.postMessage({ type: 'stop' });
        setUiState('TRANSCRIBING');
      } else {
        result.textContent = '';
        vscode.postMessage({ type: 'start' });
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'state') {
        setUiState(msg.state, msg.text);
      } else if (msg.type === 'result') {
        setUiState('READY');
        status.textContent = '✓ Copied to clipboard';
        result.textContent = msg.text;
      }
    });
  </script>
</body>
</html>`;
}

export function deactivate() {
  killPythonProcess();
}
