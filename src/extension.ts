import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';

let panel: vscode.WebviewPanel | undefined;

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

    panel.webview.html = getWebviewContent();

    panel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'audio') {
        await transcribeAudio(message.data, context);
      }
    });

    panel.onDidDispose(() => {
      panel = undefined;
    });
  });

  context.subscriptions.push(disposable);
}

async function transcribeAudio(base64Wav: string, context: vscode.ExtensionContext) {
  const tmpFile = path.join(os.tmpdir(), `whisper_${Date.now()}.wav`);

  try {
    // Guardar WAV temporal
    const buffer = Buffer.from(base64Wav, 'base64');
    fs.writeFileSync(tmpFile, buffer);

    // Ruta al script Python y caché de modelos
    const scriptPath = path.join(context.extensionPath, 'src', 'transcribe.py');
    const cacheDir = path.join(context.globalStorageUri.fsPath, 'models');
    fs.mkdirSync(cacheDir, { recursive: true });

    // Buscar uv
    const uvPath = findUv();
    if (!uvPath) {
      vscode.window.showErrorMessage('No se encontró "uv". Instálalo desde https://docs.astral.sh/uv/');
      return;
    }

    panel?.webview.postMessage({ type: 'status', text: 'Transcribiendo...' });

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '🎤 Transcribiendo audio...', cancellable: false },
      () => new Promise<void>((resolve, reject) => {
        execFile(
          uvPath,
          ['run', '--with', 'faster-whisper', 'python', scriptPath, tmpFile, 'small', 'es', cacheDir],
          { timeout: 60000 },
          async (error, stdout, stderr) => {
            if (error) {
              vscode.window.showErrorMessage(`Error al transcribir: ${stderr || error.message}`);
              panel?.webview.postMessage({ type: 'error', text: stderr || error.message });
              reject(error);
              return;
            }

            const text = stdout.trim();
            if (!text) {
              vscode.window.showWarningMessage('No se detectó texto en el audio.');
              panel?.webview.postMessage({ type: 'status', text: 'Sin resultado. ¿Grabaste algo?' });
              resolve();
              return;
            }

            await vscode.env.clipboard.writeText(text);
            vscode.window.showInformationMessage(`✓ Copiado: "${text}"`);
            panel?.webview.postMessage({ type: 'result', text });
            resolve();
          }
        );
      })
    );
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

function findUv(): string | undefined {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'uv.exe'),
    path.join(os.homedir(), '.local', 'bin', 'uv'),
    'uv',
  ];
  for (const c of candidates) {
    if (c === 'uv') return c;
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

function getWebviewContent(): string {
  return /* html */`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
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

  <script>
    const vscode = acquireVsCodeApi();
    const btn = document.getElementById('btn');
    const status = document.getElementById('status');
    const result = document.getElementById('result');

    let mediaRecorder = null;
    let chunks = [];
    let isRecording = false;
    let stream = null;

    btn.addEventListener('click', async () => {
      if (isRecording) {
        mediaRecorder.stop();
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        chunks = [];

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
          isRecording = false;
          btn.classList.remove('recording');
          btn.textContent = '🎤';
          status.textContent = 'Procesando...';
          stream.getTracks().forEach(t => t.stop());

          const blob = new Blob(chunks, { type: 'audio/webm' });
          const wav = await convertToWav(blob);
          const base64 = arrayBufferToBase64(wav);
          vscode.postMessage({ type: 'audio', data: base64 });
        };

        mediaRecorder.start();
        isRecording = true;
        btn.classList.add('recording');
        btn.textContent = '⏹';
        status.textContent = 'Grabando... (pulsa para detener)';
        result.textContent = '';
      } catch (err) {
        status.textContent = 'Error: no se pudo acceder al micrófono';
        console.error(err);
      }
    });

    async function convertToWav(blob) {
      const arrayBuffer = await blob.arrayBuffer();
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      return encodeWav(decoded);
    }

    function encodeWav(audioBuffer) {
      const samples = audioBuffer.getChannelData(0);
      const sampleRate = audioBuffer.sampleRate;
      const dataLen = samples.length * 2;
      const buf = new ArrayBuffer(44 + dataLen);
      const view = new DataView(buf);

      const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
      writeStr(0, 'RIFF');
      view.setUint32(4, 36 + dataLen, true);
      writeStr(8, 'WAVE');
      writeStr(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);    // PCM
      view.setUint16(22, 1, true);    // mono
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeStr(36, 'data');
      view.setUint32(40, dataLen, true);

      let off = 44;
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
      }
      return buf;
    }

    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'result') {
        status.textContent = '✓ Copiado al portapapeles';
        result.textContent = msg.text;
      } else if (msg.type === 'status') {
        status.textContent = msg.text;
      } else if (msg.type === 'error') {
        status.textContent = '✗ Error al transcribir';
        result.textContent = msg.text;
      }
    });
  </script>
</body>
</html>`;
}

export function deactivate() {}
