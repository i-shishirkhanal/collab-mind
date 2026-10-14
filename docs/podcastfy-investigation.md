# Podcastfy investigation (REA + published-source inspection)

Target: https://github.com/souzatharsis/podcastfy and its published PyPI `podcastfy==0.4.3` wheel.

REA 6.4.0 `inspect-artifact` was run on the wheel, using the CLI because this session did not expose
the newly registered MCP tools. It inspected the package without executing it.

- REA Evidence ID: `ev_0f1d7ca73e25517b00cd197c8a5c0e855d8844b417541bc380d2e0be80a68242`.
- Published wheel SHA-256: `da1cd8112cb4716506f8b9c19f4817c974de23b9d45e4864d408c5f17ee4ce15`.
- Provider: `rea-artifact-graph` / safe artifact inventory. REA classified it as ZIP.
- The complete local Evidence envelope was retained in the implementation host's temporary
  `collabmind-podcastfy/rea-evidence.json`. It is inventory evidence, not evidence of successful TTS.

The following findings came from direct inspection of the wheel's Python source and metadata,
not from REA native decompilation or runtime observation:

| Question | Finding | Evidence location | Status |
|---|---|---|---|
| Reuse speech without a second LLM? | `TextToSpeech.convert_to_speech(text, output_file)` consumes an existing dialogue. | `podcastfy/text_to_speech.py` | Answered statically |
| Required dialogue format? | Alternating Person1/Person2 pairs; the implementation validates these before rendering. | `podcastfy/tts/base.py`, `split_qa` | Answered statically |
| Providers used here? | Edge accepts configured voice IDs without a key; OpenAI accepts a key. | `podcastfy/tts/factory.py`, `tts/providers/edge.py`, `tts/providers/openai.py` | Answered statically |
| Runtime boundary? | Edge expects a current event loop; audio merging uses pydub/FFmpeg. | `tts/providers/edge.py`, `text_to_speech.py` | Answered statically |
| Compatible with main AI dependencies? | Requires LangChain <0.4 and NumPy <2; the app uses newer LangChain. Use a separate 3.11 environment. | Wheel `METADATA`; upstream `pyproject.toml` | Answered statically |
| Actual provider quality/availability? | Not established by static inspection or mocked tests. | No live recording in this investigation | Unresolved |

Implementation choice: retain CollabMind's workspace-scoped retrieval/model accounting and use
Podcastfy only for audio rendering. No upstream Python implementation was copied into the project.

A bounded local probe also executed the published wheel's pure-Python `TTSProvider.split_qa` with
one host/guest pair. It returned the expected pair. This was an ordinary Python probe, not REA
runtime-capture Evidence, and did not contact a speech provider or validate an audio recording.
