#!/usr/bin/env python3
"""
Transcribe un archivo de audio usando faster-whisper.
Uso: python transcribe.py <audio_file> [modelo] [idioma]
"""
import sys
import os

audio_file = sys.argv[1]
model_name = sys.argv[2] if len(sys.argv) > 2 else "small"
language = sys.argv[3] if len(sys.argv) > 3 else "es"

# Directorio de caché para los modelos
cache_dir = sys.argv[4] if len(sys.argv) > 4 else None

from faster_whisper import WhisperModel

model = WhisperModel(
    model_name,
    device="cpu",
    compute_type="int8",
    download_root=cache_dir
)

segments, info = model.transcribe(audio_file, language=language)
text = "".join(segment.text for segment in segments).strip()
print(text)
