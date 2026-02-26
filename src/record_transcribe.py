#!/usr/bin/env python3
"""
Graba audio del micrófono y transcribe con faster-whisper.
Uso: python record_transcribe.py <model_name> <language> <cache_dir>

Protocolo:
  - Escribe "READY\n" a stdout cuando el stream de audio está abierto.
  - Bloquea en stdin.readline() esperando señal de stop (\n).
  - Al recibir \n: para grabación, guarda WAV temporal, transcribe, imprime texto, elimina WAV.

Prefijos de error en stderr: ERROR_AUDIO:, ERROR_EMPTY:, ERROR_TOO_SHORT:
"""
import sys
import os
import threading
import tempfile
import wave
import struct

import numpy as np
import sounddevice as sd

model_name = sys.argv[1] if len(sys.argv) > 1 else "small"
language   = sys.argv[2] if len(sys.argv) > 2 else "es"
cache_dir  = sys.argv[3] if len(sys.argv) > 3 else None

SAMPLE_RATE   = 16000
CHANNELS      = 1
DTYPE         = "int16"
CHUNK_FRAMES  = int(SAMPLE_RATE * 0.1)  # 100 ms

chunks: list = []
chunks_lock = threading.Lock()
stop_event  = threading.Event()


def audio_callback(indata, frames, time_info, status):
    if status:
        print(f"ERROR_AUDIO: {status}", file=sys.stderr, flush=True)
    with chunks_lock:
        chunks.append(indata.copy())


try:
    stream = sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype=DTYPE,
        blocksize=CHUNK_FRAMES,
        callback=audio_callback,
    )
    stream.start()
except Exception as e:
    print(f"ERROR_AUDIO: No se pudo abrir el micrófono: {e}", file=sys.stderr, flush=True)
    sys.exit(1)

# Señal al host: listo para grabar
sys.stdout.write("READY\n")
sys.stdout.flush()

# Esperar señal de stop (\n desde stdin)
sys.stdin.readline()

stream.stop()
stream.close()

# Concatenar chunks
with chunks_lock:
    all_chunks = list(chunks)

if not all_chunks:
    print("ERROR_EMPTY: No se grabó audio.", file=sys.stderr, flush=True)
    sys.exit(1)

audio_data = np.concatenate(all_chunks, axis=0).flatten()

MIN_SECONDS = 0.3
if len(audio_data) < SAMPLE_RATE * MIN_SECONDS:
    print("ERROR_TOO_SHORT: Grabación demasiado corta.", file=sys.stderr, flush=True)
    sys.exit(1)

# Guardar WAV temporal
tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav", prefix="whisper_")
os.close(tmp_fd)

try:
    with wave.open(tmp_path, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)  # int16 = 2 bytes
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio_data.tobytes())

    from faster_whisper import WhisperModel

    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        download_root=cache_dir,
    )

    segments, _ = model.transcribe(tmp_path, language=language)
    text = "".join(seg.text for seg in segments).strip()
    print(text, flush=True)

finally:
    if os.path.exists(tmp_path):
        os.unlink(tmp_path)
