"""Workspace podcast jobs. DeepSeek writes cited dialogue; an isolated Podcastfy process renders audio."""
import asyncio
import html
import json
import logging
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from db import get_pool
from llm.types import Task
from rag.generator import _generate_json, NoRelevantSourcesError
from rag.grounding import citation_for, fence, select_passages
from rag.retriever import sample_chunks

log = logging.getLogger('collabmind.podcasts')
router = APIRouter()
LANGUAGES = {
    'English': ('en-US-JennyNeural', 'en-US-GuyNeural'),
    'Hindi': ('hi-IN-SwaraNeural', 'hi-IN-MadhurNeural'),
    'Spanish': ('es-ES-ElviraNeural', 'es-ES-AlvaroNeural'),
    'French': ('fr-FR-DeniseNeural', 'fr-FR-HenriNeural'),
}
ACTIVE = "('queued','scripting','synthesizing')"
_slots = None


class PodcastRequest(BaseModel):
    workspace_id: UUID
    user_id: UUID
    source_ids: Annotated[list[UUID], Field(min_length=1, max_length=6)]
    topic: Annotated[str, Field(max_length=500)] = ''
    language: Literal['English', 'Hindi', 'Spanish', 'French'] = 'English'
    length: Literal['short', 'standard'] = 'short'


class Turn(BaseModel):
    speaker: Literal['host', 'guest']
    text: Annotated[str, Field(min_length=1, max_length=1500)]
    citations: Annotated[list[int], Field(min_length=1, max_length=8)]


class Script(BaseModel):
    turns: Annotated[list[Turn], Field(min_length=4, max_length=24)]


def output_root():
    return Path(os.environ.get('PODCAST_OUTPUT_DIR', str(Path(os.environ.get('UPLOADS_DIR', '/app/uploads')) / 'podcasts'))).resolve()


def audio_path(workspace_id, podcast_id):
    # UUID parsing, rather than a model/client supplied filename, fixes the storage boundary.
    return output_root() / str(UUID(str(workspace_id))) / f'{UUID(str(podcast_id))}.mp3'


def runtime():
    python = os.environ.get('PODCAST_PYTHON', '').strip()
    provider = os.environ.get('PODCAST_TTS_PROVIDER', 'edge').strip().lower()
    configured = bool(python and Path(python).is_file() and provider in ('edge', 'openai'))
    if provider == 'openai':
        configured = configured and bool(os.environ.get('PODCAST_OPENAI_API_KEY', '').strip())
    return {'available': configured, 'provider': provider, 'languages': list(LANGUAGES),
            'message': None if configured else 'Podcast audio is not configured on this server. See the podcast setup guide.'}


def clean_script(script, passages):
    """Enforce paired speakers and real citation indices before anything can be spoken."""
    if len(script.turns) % 2:
        raise ValueError('The dialogue must have complete speaker pairs')
    for i, turn in enumerate(script.turns):
        if turn.speaker != ('host' if i % 2 == 0 else 'guest'):
            raise ValueError('The speakers must alternate')
        turn.citations = list(dict.fromkeys(n for n in turn.citations if 1 <= n <= len(passages)))
        if not turn.citations or not turn.text.strip():
            raise ValueError('Each turn needs a valid passage reference')
        # Speech markup and URLs are data, never provider instructions or additional fetches.
        turn.text = re.sub(r'<[^>]*>|\[\d+\]', '', turn.text).strip()
        if not turn.text:
            raise ValueError('A dialogue turn was empty')
    if sum(len(t.text) for t in script.turns) > 16000:
        raise ValueError('The dialogue exceeded the audio budget')
    return script


def speech_markup(script):
    return '\n'.join(f'<Person{1 if t.speaker == "host" else 2}>{html.escape(t.text)}</Person{1 if t.speaker == "host" else 2}>' for t in script.turns)


def render_audio(markup, language, destination):
    """Blocking child process with a deadline; called in a thread to keep the API responsive."""
    settings = runtime()
    if not settings['available']:
        raise RuntimeError('Podcast runtime is unavailable')
    voices = LANGUAGES[language] if settings['provider'] == 'edge' else ('alloy', 'nova')
    payload = json.dumps({'provider': settings['provider'], 'voices': voices, 'transcript': markup})
    env = {k: os.environ[k] for k in ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
                                    'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY') if k in os.environ}
    env.update({'LANGCHAIN_TRACING_V2': 'false', 'ANONYMIZED_TELEMETRY': 'false',
                'OPENAI_API_KEY': os.environ.get('PODCAST_OPENAI_API_KEY', '')})
    worker = Path(__file__).parent / 'scripts' / 'podcast_tts_worker.py'
    with tempfile.TemporaryDirectory(prefix='collabmind-podcast-') as temp:
        # Logs stay local to the temporary job; do not expose vendor bodies/credentials to users.
        with open(Path(temp) / 'worker.log', 'wb') as log_file:
            result = subprocess.run([os.environ['PODCAST_PYTHON'], '-I', str(worker)],
                                    input=payload.encode('utf-8'), stdout=log_file, stderr=log_file,
                                    cwd=temp, env=env, timeout=600, check=False)
        source = Path(temp) / 'audio.mp3'
        if result.returncode or not source.is_file() or not 100 < source.stat().st_size <= 40 * 1024 * 1024:
            raise RuntimeError('Audio synthesis did not produce a usable file')
        destination.parent.mkdir(parents=True, exist_ok=True)
        staged = destination.with_suffix('.part')
        shutil.copyfile(source, staged)
        staged.replace(destination)


async def update(pool, podcast_id, status, **fields):
    # Field names are fixed in code; values always remain parameters.
    names, values = ['status = $2', 'updated_at = NOW()'], [podcast_id, status]
    for key in ('transcript', 'citations', 'warnings', 'error'):
        if key in fields:
            values.append(json.dumps(fields[key]) if key != 'error' else fields[key])
            names.append(f'{key} = ${len(values)}' + ('::jsonb' if key != 'error' else ''))
    allowed = "('queued')" if status == 'scripting' else ACTIVE
    result = await pool.execute(f'UPDATE studio_podcasts SET {", ".join(names)} WHERE id = $1 AND status IN {allowed}', *values)
    return result == 'UPDATE 1'


async def generate(pool, podcast_id, request):
    global _slots
    if _slots is None:
        _slots = asyncio.Semaphore(2)
    async with _slots:
        try:
            if not await update(pool, podcast_id, 'scripting'):
                return  # expired or deleted while waiting for a synthesis slot
            chunks = await sample_chunks(pool, str(request.workspace_id), 48, source_ids=[str(s) for s in request.source_ids])
            passages = select_passages(chunks, 28000)
            if not passages:
                raise NoRelevantSourcesError('No active indexed passages remain in the selected sources.')
            context = '\n\n'.join(f'[{i}] {p["source_name"]}\n{p["content"]}' for i, p in enumerate(passages, 1))
            budget = '300–450 words in 8–12 turns' if request.length == 'short' else '650–900 words in 12–20 turns'
            draft = await _generate_json(
                pool, str(request.workspace_id), 'podcast', Task.STUDY,
                'Write a two-person educational conversation using ONLY the provided passages. Every turn must '
                'include at least one supporting passage number. The host asks source-specific questions and '
                'the guest explains the evidence. Do not invent facts, URLs, introductions with personal names, '
                'or claims about unavailable material. Use plain text, no markup or citation markers in text. '
                'Return JSON {"turns":[{"speaker":"host"|"guest","text":"...","citations":[1]}]}. '
                f'Write in {request.language}, aim for {budget}, start with host, alternate speakers, end with guest.',
                fence('TOPIC', request.topic or 'Main ideas and key takeaways') + '\n' + fence('SOURCE PASSAGES', context),
                Script, user_id=str(request.user_id),
            )
            script = clean_script(draft, passages)
            warnings = ['AI-generated dialogue: check important claims against the source references.',
                        'Uses selected excerpts, not necessarily every part of each document. Length is approximate.']
            saved = await update(pool, podcast_id, 'synthesizing', transcript=[t.model_dump() for t in script.turns],
                                 citations=[citation_for(i, p).model_dump() for i, p in enumerate(passages, 1)], warnings=warnings)
            if not saved:
                return
            destination = audio_path(request.workspace_id, podcast_id)
            await asyncio.to_thread(render_audio, speech_markup(script), request.language, destination)
            if not await update(pool, podcast_id, 'ready'):
                destination.unlink(missing_ok=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception('Podcast generation failed for job %s', podcast_id)
            await update(pool, podcast_id, 'failed', error='Podcast generation failed. Check the audio service configuration or try again.')


@router.get('/studio/podcasts/config')
async def config_endpoint():
    return runtime()


@router.post('/studio/podcasts', status_code=202)
async def create_endpoint(body: PodcastRequest, background_tasks: BackgroundTasks):
    if not runtime()['available']:
        raise HTTPException(503, runtime()['message'])
    ids = list(dict.fromkeys(body.source_ids))
    pool = await get_pool()
    rows = await pool.fetch("SELECT id FROM sources WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND status = 'ready' AND is_active",
                            body.workspace_id, ids)
    if len(rows) != len(ids):
        raise HTTPException(404, 'Choose processed, active sources from this workspace.')
    podcast_id = uuid4()
    try:
        await pool.execute('INSERT INTO studio_podcasts(id,workspace_id,user_id,params) VALUES($1,$2,$3,$4::jsonb)',
                           podcast_id, body.workspace_id, body.user_id, body.model_dump_json(exclude={'workspace_id', 'user_id'}))
    except Exception as exc:
        if getattr(exc, 'sqlstate', None) == '23505':
            raise HTTPException(409, 'A podcast is already being generated in this workspace.') from None
        raise
    background_tasks.add_task(generate, pool, podcast_id, body)
    return {'id': str(podcast_id), 'status': 'queued'}


@router.get('/studio/podcasts/{podcast_id}/audio')
async def audio_endpoint(podcast_id: UUID, workspace_id: UUID):
    pool = await get_pool()
    row = await pool.fetchrow("SELECT status FROM studio_podcasts WHERE id = $1 AND workspace_id = $2", podcast_id, workspace_id)
    if not row or row['status'] != 'ready':
        raise HTTPException(404, 'Podcast audio is not available.')
    path = audio_path(workspace_id, podcast_id)
    if not path.is_file():
        raise HTTPException(404, 'This audio file is no longer available. Generate a new podcast.')
    return FileResponse(path, media_type='audio/mpeg', filename=f'collabmind-{podcast_id}.mp3',
                        headers={'Cache-Control': 'private, no-store'})


async def reaper_loop(pool):
    while True:
        try:
            await pool.execute(f"UPDATE studio_podcasts SET status='failed', error='This run did not finish. Generate a new podcast.', updated_at=NOW() WHERE status IN {ACTIVE} AND created_at < NOW() - INTERVAL '25 minutes'")
            expired = await pool.fetch("DELETE FROM studio_podcasts WHERE created_at < NOW() - INTERVAL '7 days' RETURNING id,workspace_id")
            for row in expired:
                audio_path(row['workspace_id'], row['id']).unlink(missing_ok=True)
            # Workspace deletion cascades rows. Clean its orphaned audio without following symlinks.
            root = output_root()
            if root.is_dir():
                for folder in root.iterdir():
                    if not folder.is_dir() or folder.is_symlink():
                        continue
                    try:
                        workspace = UUID(folder.name)
                    except ValueError:
                        continue
                    if not await pool.fetchval('SELECT 1 FROM workspaces WHERE id=$1', workspace):
                        for file in folder.glob('*.mp3'):
                            if not file.is_symlink():
                                file.unlink(missing_ok=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception('Podcast cleanup failed')
        await asyncio.sleep(300)
