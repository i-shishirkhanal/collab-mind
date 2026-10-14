# Podcast Studio

Open **Workspace → Studio → Podcast Studio**, select one to six ready, active sources, choose English,
Hindi, Spanish, or French and a short/standard length, and optionally enter a focus. The workspace
shares generation status and history. A completed podcast has an authenticated audio player, MP3
download, transcript, and clickable source references. The transcript remains available when speech
generation fails after scripting. Durations are approximate, not guaranteed.

CollabMind's existing model router writes a bounded two-speaker script from indexed excerpts, tracks
token usage against the caller, and resolves references against real source chunks. Podcastfy 0.4.3
renders that script through its `TextToSpeech` API. Its content extractor, topic search and LLM calls
are not used: selected source text is the only content input. Structural citation validation does not
prove that every statement is true; users should check important claims.

## Deployment and configuration

1. Apply `supabase/migrations/20261014010000_studio_podcasts.sql` with the normal migration workflow.
2. Rebuild/restart the AI service, backend, and frontend. The AI Dockerfile installs system FFmpeg and
   Podcastfy in `/opt/podcast`, a separate Python 3.11 environment. The main AI environment is unchanged.
3. Edge TTS is the default. It requires outbound access to Microsoft's speech service but no extra API
   key. Availability depends on that external service. The transcript text is sent to the speech provider.
4. To use OpenAI speech, set `PODCAST_TTS_PROVIDER=openai` and `PODCAST_OPENAI_API_KEY` on the AI service.
   These are server-side settings, never browser configuration. Compose forwards both settings.

Native development requires a separate **Python 3.11 or 3.12** environment and FFmpeg on PATH:

```powershell
py -3.11 -m venv C:\path\to\podcast-env
C:\path\to\podcast-env\Scripts\python.exe -m pip install -r ai/requirements-podcast.txt
# Set in ai/.env (or exported environment before starting the AI service):
# PODCAST_PYTHON=C:/path/to/podcast-env/Scripts/python.exe
```

The native environment also needs a writable `podcastfy/data/audio/tmp` directory under its installed
package. Docker provisions this for the unprivileged app user. Podcastfy's LangChain 0.3 and NumPy <2
constraints conflict with the main service's newer packages; do not combine the requirements files.
Python 3.13/3.14 is not supported for this isolated worker (upstream audio/NumPy compatibility).

Audio is stored under `PODCAST_OUTPUT_DIR`, defaulting to `<UPLOADS_DIR>/podcasts`. Compose's existing
uploads volume persists these files. On another host, mount persistent storage there and use a single
AI instance or shared filesystem. A plain ephemeral container loses audio on restart; the player then
reports that regeneration is needed. This implementation does not upload podcasts to Supabase/GCS.

## Jobs and limits

- The API returns a job ID immediately. PostgreSQL stores queued/scripting/synthesizing/ready/failed
  states, options, transcript and evidence. Clients poll while work proceeds and restore jobs on reload.
- One active job per workspace is enforced by a partial unique index; each AI process runs at most two
  generation jobs at a time. Creation shares the existing per-user AI tool rate limit.
- Audio synthesis runs in a separate interpreter with a ten-minute deadline, a 16,000-character script
  cap and 40 MiB output cap. Database and AI-service credentials are not forwarded to that process.
- Jobs run in-process, not on a durable queue. A five-minute sweep marks runs older than 25 minutes as
  failed. Expired queued jobs cannot restart later when a concurrency slot opens.
- History/audio are retained for seven days; the sweep deletes expired rows and files. Workspace
  deletion cascades rows, and the sweep removes that workspace's orphan audio. Keep the AI service
  running to perform cleanup. The UI lists the latest 20 workspace podcasts.
- Every metadata/audio request checks workspace membership. Audio is proxied through Express with
  private/no-store headers. Browser audio uses an authenticated fetch and a revocable blob URL;
  access tokens and provider secrets never appear in audio URLs.

## Validation

Backend tests: `node --test test/podcasts.test.js`.
AI tests: `python -m pytest tests/test_podcasts.py tests/test_api.py tests/test_generator.py -q`.
Frontend: TypeScript, ESLint, existing tests, production webpack build.

The implementation's isolated SQL validation checks the migration, active-job uniqueness, states,
and workspace cascade behavior. A full browser/provider run still requires a migrated database,
model credentials, reachable TTS service, and an allowed Podcastfy interpreter. On the implementation
host, Windows Application Control blocked execution of the downloaded Python 3.11 interpreter;
the host policy was preserved. No live speech-generation success is claimed from the mocked tests.
