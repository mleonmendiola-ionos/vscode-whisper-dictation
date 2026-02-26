#!/usr/bin/env python3
"""
Recording and transcription daemon with faster-whisper.
Usage: python record_transcribe.py <model_name> <language> <cache_dir>
Protocol: LOADING → READY → (START → RECORDING → STOP → RESULT/ERROR) × N
"""
import sys, os, threading, tempfile, wave
sys.stdout.reconfigure(encoding='utf-8')
sys.stdin.reconfigure(encoding='utf-8')
import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel

model_name = sys.argv[1] if len(sys.argv) > 1 else "small"
language   = sys.argv[2] if len(sys.argv) > 2 else "es"
cache_dir  = sys.argv[3] if len(sys.argv) > 3 else None

SAMPLE_RATE  = 16000
CHANNELS     = 1
DTYPE        = "int16"
CHUNK_FRAMES = int(SAMPLE_RATE * 0.1)
MIN_SECONDS  = 0.3

def emit(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()

emit("LOADING")
try:
    model = WhisperModel(model_name, device="cpu", compute_type="int8", download_root=cache_dir)
except Exception as e:
    emit(f"ERROR:Could not load model: {e}")
    sys.exit(1)
emit("READY")

while True:
    line = sys.stdin.readline()
    if not line or line.strip() != "START":
        if not line:
            break
        continue

    chunks = []
    lock = threading.Lock()

    def audio_callback(indata, frames, time_info, status):
        with lock:
            chunks.append(indata.copy())

    try:
        stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=CHANNELS,
                                dtype=DTYPE, blocksize=CHUNK_FRAMES, callback=audio_callback)
        stream.start()
    except Exception as e:
        emit(f"ERROR:Could not open microphone: {e}")
        continue

    emit("RECORDING")

    while True:
        stop_line = sys.stdin.readline()
        if not stop_line:
            stream.stop()
            stream.close()
            sys.exit(0)
        if stop_line.strip() == "STOP":
            break

    stream.stop()
    stream.close()

    with lock:
        all_chunks = list(chunks)

    if not all_chunks:
        emit("ERROR:No audio was recorded.")
        continue

    audio_data = np.concatenate(all_chunks, axis=0).flatten()
    if len(audio_data) < SAMPLE_RATE * MIN_SECONDS:
        emit("ERROR:Recording too short.")
        continue

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".wav", prefix="whisper_")
    os.close(tmp_fd)
    try:
        with wave.open(tmp_path, "wb") as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(audio_data.tobytes())
        segments, _ = model.transcribe(tmp_path, language=language)
        text = "".join(s.text for s in segments).strip()
        emit(f"RESULT:{text}" if text else "ERROR:Empty transcription.")
    except Exception as e:
        emit(f"ERROR:Transcription failed: {e}")
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
