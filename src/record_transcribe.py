#!/usr/bin/env python3
"""
Recording and transcription daemon with faster-whisper.
Usage: python record_transcribe.py <model_name> <language> <cache_dir> [device]
Protocol: DOWNLOADING/LOADING → READY:<device> → (START → RECORDING → STOP → RESULT/ERROR) × N
"""
import sys, os, threading, queue
sys.stdout.reconfigure(encoding='utf-8')
sys.stdin.reconfigure(encoding='utf-8')
import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel

model_name  = sys.argv[1] if len(sys.argv) > 1 else "small"
language    = sys.argv[2] if len(sys.argv) > 2 else "es"
cache_dir   = sys.argv[3] if len(sys.argv) > 3 else None
device_pref = sys.argv[4] if len(sys.argv) > 4 else "auto"

SAMPLE_RATE    = 16000
CHANNELS       = 1
DTYPE          = "int16"
CHUNK_FRAMES   = int(SAMPLE_RATE * 0.1)
MIN_SECONDS    = 0.3
MAX_SECONDS    = 300  # 5 minutes

def emit(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()

# Read stdin in a dedicated thread, push commands to a queue
cmd_queue = queue.Queue()

def stdin_reader():
    for line in sys.stdin:
        cmd_queue.put(line.strip())
    cmd_queue.put(None)  # EOF

threading.Thread(target=stdin_reader, daemon=True).start()

def detect_device(preference):
    """Resolve device preference to actual device and compute type."""
    if preference == "cpu":
        return "cpu", "int8"
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"

def is_model_cached(name, directory):
    """Check if the model is already downloaded in the cache."""
    if not directory:
        return False
    hub_dir = os.path.join(directory, f"models--Systran--faster-whisper-{name}")
    return os.path.isdir(hub_dir)

device, compute_type = detect_device(device_pref)
emit("LOADING" if is_model_cached(model_name, cache_dir) else "DOWNLOADING")
try:
    model = WhisperModel(model_name, device=device, compute_type=compute_type, download_root=cache_dir)
except Exception as e:
    emit(f"ERROR:Could not load model: {e}")
    sys.exit(1)
emit(f"READY:{device}")

while True:
    cmd = cmd_queue.get()
    if cmd is None or cmd != "START":
        if cmd is None:
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

    # Wait for STOP command or timeout after MAX_SECONDS
    timed_out = False
    try:
        cmd = cmd_queue.get(timeout=MAX_SECONDS)
        if cmd is None:
            stream.stop()
            stream.close()
            sys.exit(0)
    except queue.Empty:
        timed_out = True

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

    # Transcribe directly from numpy array (no temp file)
    audio_float = audio_data.astype(np.float32) / 32768.0
    try:
        segments, _ = model.transcribe(audio_float, language=language)
        text = "".join(s.text for s in segments).strip()
        if timed_out:
            text = text + " [max duration reached]" if text else ""
        emit(f"RESULT:{text}" if text else "ERROR:Empty transcription.")
    except Exception as e:
        emit(f"ERROR:Transcription failed: {e}")
