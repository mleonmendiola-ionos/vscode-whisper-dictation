import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as crypto from 'crypto';

let panel: vscode.WebviewPanel | undefined;
let pythonProcess: ChildProcessWithoutNullStreams | undefined;
let pythonOutput = '';
let pythonError  = '';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('whisper-dictation.toggle', () => {
    if (panel) {
      panel.reveal();
      return;
    }

    panel = vscode.window.createWebviewPanel(
      'whisperDictation',
      '🎤 Dictado por Voz',
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
        await startRecording(context);
      } else if (message.type === 'stop') {
        stopRecording();
      }
    });

    panel.onDidDispose(() => {
      killPythonProcess();
      panel = undefined;
    });
  });

  context.subscriptions.push(disposable);
}

async function startRecording(context: vscode.ExtensionContext) {
  const scriptPath = path.join(context.extensionPath, 'src', 'record_transcribe.py');
  const cacheDir = path.join(context.globalStorageUri.fsPath, 'models');
  fs.mkdirSync(cacheDir, { recursive: true });

  const uvPath = findUv();
  if (!uvPath) {
    vscode.window.showErrorMessage('No se encontró "uv". Instálalo desde https://docs.astral.sh/uv/');
    panel?.webview.postMessage({ type: 'error', text: 'uv no encontrado' });
    return;
  }

  pythonOutput = '';
  pythonError  = '';

  pythonProcess = spawn(
    uvPath,
    ['run', '--with', 'sounddevice', '--with', 'numpy', '--with', 'faster-whisper', 'python', scriptPath, 'small', 'es', cacheDir],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  ) as ChildProcessWithoutNullStreams;

  pythonProcess.stdout.on('data', (data: Buffer) => {
    const text = data.toString();
    if (text.startsWith('READY')) {
      panel?.webview.postMessage({ type: 'status', text: 'Grabando...' });
    } else {
      pythonOutput += text;
    }
  });

  pythonProcess.stderr.on('data', (data: Buffer) => {
    pythonError += data.toString();
  });

  pythonProcess.on('close', async (code: number | null) => {
    const text = pythonOutput.trim();
    pythonProcess = undefined;

    if (code !== 0 || !text) {
      const errMsg = pythonError.trim() || `Proceso terminó con código ${code}`;
      vscode.window.showErrorMessage(`Error al grabar/transcribir: ${errMsg}`);
      panel?.webview.postMessage({ type: 'error', text: errMsg });
      return;
    }

    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`✓ Copiado: "${text}"`);
    panel?.webview.postMessage({ type: 'result', text });
  });

  pythonProcess.on('error', (err: Error) => {
    vscode.window.showErrorMessage(`No se pudo iniciar Python: ${err.message}`);
    panel?.webview.postMessage({ type: 'error', text: err.message });
    pythonProcess = undefined;
  });

  panel?.webview.postMessage({ type: 'status', text: 'Iniciando grabación...' });
}

function stopRecording() {
  if (!pythonProcess) return;
  try {
    pythonProcess.stdin.write('\n');
    pythonProcess.stdin.end();
  } catch {
    // proceso ya terminó
  }
  panel?.webview.postMessage({ type: 'status', text: 'Transcribiendo...' });
}

function killPythonProcess() {
  if (pythonProcess) {
    try { pythonProcess.kill(); } catch { /* ignore */ }
    pythonProcess = undefined;
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
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dictado por Voz</title>
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
    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
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
  <button id="btn" title="Haz clic para grabar">🎤</button>
  <div id="status">Haz clic para empezar a grabar</div>
  <div id="result"></div>
  <div id="hint">El texto se copia al portapapeles automáticamente.<br>Pega con Ctrl+V donde lo necesites.</div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const btn = document.getElementById('btn');
    const status = document.getElementById('status');
    const result = document.getElementById('result');

    let isRecording = false;

    btn.addEventListener('click', () => {
      if (isRecording) {
        vscode.postMessage({ type: 'stop' });
        btn.disabled = true;
      } else {
        isRecording = true;
        btn.classList.add('recording');
        btn.textContent = '⏹';
        result.textContent = '';
        status.textContent = 'Iniciando grabación...';
        vscode.postMessage({ type: 'start' });
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'result') {
        isRecording = false;
        btn.disabled = false;
        btn.classList.remove('recording');
        btn.textContent = '🎤';
        status.textContent = '✓ Copiado al portapapeles';
        result.textContent = msg.text;
      } else if (msg.type === 'status') {
        status.textContent = msg.text;
        if (msg.text.includes('Grabando')) {
          btn.disabled = false;
        }
      } else if (msg.type === 'error') {
        isRecording = false;
        btn.disabled = false;
        btn.classList.remove('recording');
        btn.textContent = '🎤';
        status.textContent = '✗ Error';
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
