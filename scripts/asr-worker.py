"""Persistent, offline Apple Silicon ASR worker. Audio exists only in memory."""
import base64
import importlib
import json
import math
import sys
import time

import mlx.core as mx
import numpy as np
from scipy.signal import resample_poly

transcriber = importlib.import_module('mlx_whisper.transcribe')
model_path = sys.argv[1]
transcriber.ModelHolder.get_model(model_path, mx.float16)
print(json.dumps({'event': 'ready'}), flush=True)

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        started = time.monotonic()
        audio = np.frombuffer(base64.b64decode(request['pcm'], validate=True), dtype='<i2').astype(np.float32) / 32768.0
        rate = int(request['sampleRate'])
        if rate != 16000:
            divisor = math.gcd(rate, 16000)
            audio = resample_poly(audio, 16000 // divisor, rate // divisor).astype(np.float32)
        text = ''
        if audio.size and (np.sqrt(np.mean(audio * audio)) >= 0.001 or np.max(np.abs(audio)) >= 0.01):
            terms = str(request.get('terms', ''))[:240]
            result = transcriber.transcribe(audio, path_or_hf_repo=model_path, language='zh', task='transcribe',
                temperature=0.0, condition_on_previous_text=False, verbose=None,
                initial_prompt='以下是简体中文的项目汇报。相关专有词汇：' + terms if terms else '以下是简体中文的项目汇报。',
                no_speech_threshold=0.6, logprob_threshold=-1.0, compression_ratio_threshold=2.4)
            text = ''.join(segment['text'] for segment in result.get('segments', [])
                if not (segment.get('no_speech_prob', 0) > 0.6 and segment.get('avg_logprob', 0) < -1.0)).strip()
        print(json.dumps({'id': request['id'], 'text': text, 'elapsedMs': round((time.monotonic() - started) * 1000)}, ensure_ascii=False), flush=True)
    except Exception:
        print(json.dumps({'id': request.get('id'), 'error': '本机高精度识别失败，请重试这段发言'}), flush=True)
