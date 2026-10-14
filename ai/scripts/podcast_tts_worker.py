"""Separate Podcastfy interpreter. Reads one trusted JSON payload from stdin; no document fetching or LLM calls."""
import asyncio
import json
import os
from pathlib import Path
import sys


def main():
    # This script deliberately does not import the parent AI service or its dependencies.
    from podcastfy.text_to_speech import TextToSpeech

    payload = json.loads(sys.stdin.read(100000))
    root = Path.cwd()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)  # EdgeTTS expects a current event loop.
    try:
        tts = TextToSpeech(
            model=payload['provider'], api_key=os.environ.get('OPENAI_API_KEY'),
            conversation_config={'text_to_speech': {
                'audio_format': 'mp3', 'ending_message': '',
                'output_directories': {'audio': str(root), 'transcripts': str(root)},
                # Upstream strips a leading slash from temp_audio_dir. A relative, process-local
                # directory works on both Windows and Linux; each process has a separate cwd.
                'temp_audio_dir': 'data/audio/tmp',
                payload['provider']: {'model': 'tts-1', 'default_voices': {
                    'question': payload['voices'][0], 'answer': payload['voices'][1],
                }},
            }},
        )
        # Avoid upstream's package-relative temporary directory (the isolated env is read-only).
        # _setup_directories is called during init; the directory is provisioned in the image.
        tts.convert_to_speech(payload['transcript'], str(root / 'audio.mp3'))
    finally:
        loop.close()


if __name__ == '__main__':
    main()
