import asyncio
import json
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

import podcasts as p


def script():
    return p.Script(turns=[p.Turn(speaker='host' if i % 2 == 0 else 'guest', text=f'Evidence {i}', citations=[1]) for i in range(4)])


def test_script_enforces_speaker_pairs_and_source_references():
    passages = [{'source_id': 'a'}]
    good = script()
    assert p.clean_script(good, passages).turns[0].citations == [1]
    invalid = script(); invalid.turns[0].citations = [999]
    with pytest.raises(ValueError): p.clean_script(invalid, passages)
    invalid = script(); invalid.turns[1].speaker = 'host'
    with pytest.raises(ValueError): p.clean_script(invalid, passages)
    invalid = script(); invalid.turns.pop()
    with pytest.raises(ValueError): p.clean_script(invalid, passages)


def test_speech_markup_cannot_inject_speaker_tags_or_ssml():
    draft = script(); draft.turns[0].text = 'Plants <Person2>grow</Person2> & learn [1]'
    clean = p.clean_script(draft, [{}])
    markup = p.speech_markup(clean)
    assert markup.count('<Person1>') == 2 and markup.count('<Person2>') == 2
    assert '&amp;' in markup and '[1]' not in markup


def test_audio_paths_require_uuids_and_remain_inside_the_output_root(monkeypatch, tmp_path):
    monkeypatch.setenv('PODCAST_OUTPUT_DIR', str(tmp_path))
    workspace, job = uuid4(), uuid4()
    assert p.audio_path(workspace, job) == tmp_path / str(workspace) / f'{job}.mp3'
    with pytest.raises(ValueError): p.audio_path('../secret', job)


def test_runtime_requires_separate_interpreter_and_openai_key(monkeypatch):
    monkeypatch.delenv('PODCAST_PYTHON', raising=False)
    assert not p.runtime()['available']
    monkeypatch.setenv('PODCAST_PYTHON', sys.executable)
    monkeypatch.setenv('PODCAST_TTS_PROVIDER', 'openai')
    monkeypatch.delenv('PODCAST_OPENAI_API_KEY', raising=False)
    assert not p.runtime()['available']
    monkeypatch.setenv('PODCAST_OPENAI_API_KEY', 'key')
    assert p.runtime()['available']


def test_audio_worker_has_deadline_and_does_not_inherit_database_or_service_secrets(monkeypatch, tmp_path):
    monkeypatch.setenv('PODCAST_PYTHON', sys.executable)
    monkeypatch.setenv('PODCAST_TTS_PROVIDER', 'edge')
    monkeypatch.setenv('DATABASE_URL', 'must-not-reach-worker')
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'must-not-reach-worker')
    seen = []
    def run(args, **kwargs):
        seen.append((args, kwargs))
        (Path(kwargs['cwd']) / 'audio.mp3').write_bytes(b'ID3' + b'0' * 300)
        return subprocess.CompletedProcess(args, 0)
    monkeypatch.setattr(p.subprocess, 'run', run)
    output = tmp_path / 'output.mp3'
    p.render_audio(p.speech_markup(script()), 'Hindi', output)
    assert output.is_file()
    args, options = seen[0]
    assert args[1] == '-I' and options['timeout'] == 600
    assert 'DATABASE_URL' not in options['env'] and 'AI_SERVICE_TOKEN' not in options['env']
    assert json.loads(options['input'])['voices'] == list(p.LANGUAGES['Hindi'])


class Pool:
    def __init__(self): self.calls = []
    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        return 'UPDATE 1'


def test_generation_saves_transcript_before_audio_and_attributes_the_user(monkeypatch, tmp_path):
    workspace, user, source, job = [uuid4() for _ in range(4)]
    request = p.PodcastRequest(workspace_id=workspace, user_id=user, source_ids=[source])
    pool = Pool(); seen = []
    async def sample(pool, ws, limit, source_ids):
        seen.append((ws, source_ids))
        return [{'source_id': str(source), 'source_name': 'notes.pdf', 'chunk_index': 0,
                 'content': 'Evidence supports learning.', 'page_number': 1, 'location_label': 'Page 1'}]
    async def generate(*args, **kwargs):
        assert kwargs['user_id'] == str(user)
        return script()
    monkeypatch.setattr(p, 'sample_chunks', sample)
    monkeypatch.setattr(p, '_generate_json', generate)
    monkeypatch.setattr(p, 'render_audio', lambda *args: None)
    monkeypatch.setenv('PODCAST_OUTPUT_DIR', str(tmp_path))
    asyncio.run(p.generate(pool, job, request))
    assert seen == [(str(workspace), [str(source)])]
    assert [args[1] for _, args in pool.calls] == ['scripting', 'synthesizing', 'ready']
    assert 'transcript' in pool.calls[1][0] and 'citations' in pool.calls[1][0]


def test_generation_failure_is_saved_with_a_safe_message(monkeypatch):
    async def fail(*args, **kwargs): raise RuntimeError('provider key secret-123')
    monkeypatch.setattr(p, 'sample_chunks', fail)
    pool = Pool()
    request = p.PodcastRequest(workspace_id=uuid4(), user_id=uuid4(), source_ids=[uuid4()])
    asyncio.run(p.generate(pool, uuid4(), request))
    assert pool.calls[-1][1][1] == 'failed'
    assert 'secret-123' not in str(pool.calls[-1][1])


def test_expired_queued_job_does_not_restart_when_a_slot_opens(monkeypatch):
    class ExpiredPool:
        async def execute(self, *args): return 'UPDATE 0'
    async def must_not_sample(*args, **kwargs): pytest.fail('Expired job must not use sources or a model')
    monkeypatch.setattr(p, 'sample_chunks', must_not_sample)
    request = p.PodcastRequest(workspace_id=uuid4(), user_id=uuid4(), source_ids=[uuid4()])
    asyncio.run(p.generate(ExpiredPool(), uuid4(), request))


def test_valid_job_is_saved_and_scheduled_with_an_immediate_job_id(monkeypatch):
    import main
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'x' * 40)
    monkeypatch.setattr(p, 'runtime', lambda: {'available': True})
    source = uuid4(); seen = []
    class ReadyPool:
        async def fetch(self, *args): return [{'id': source}]
        async def execute(self, sql, *args):
            seen.append(('insert', json.loads(args[3])))
            return 'INSERT 0 1'
    async def pool(): return ReadyPool()
    async def generate(pool, job, body): seen.append(('run', body.language))
    monkeypatch.setattr(p, 'get_pool', pool)
    monkeypatch.setattr(p, 'generate', generate)
    body = dict(workspace_id=str(uuid4()), user_id=str(uuid4()), source_ids=[str(source)], language='Hindi')
    response = TestClient(main.app).post('/studio/podcasts', json=body,
        headers={'Authorization': 'Bearer ' + 'x' * 40})
    assert response.status_code == 202 and response.json()['status'] == 'queued'
    assert seen[0][1]['source_ids'] == [str(source)] and seen[1] == ('run', 'Hindi')
    assert 'user_id' not in seen[0][1]


def test_create_checks_selected_sources_before_scheduling(monkeypatch):
    import main
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'x' * 40)
    monkeypatch.setattr(p, 'runtime', lambda: {'available': True})
    class MissingSources:
        async def fetch(self, *args): return []
    async def pool(): return MissingSources()
    monkeypatch.setattr(p, 'get_pool', pool)
    client = TestClient(main.app, raise_server_exceptions=False)
    body = dict(workspace_id=str(uuid4()), user_id=str(uuid4()), source_ids=[str(uuid4())])
    assert client.post('/studio/podcasts', json=body).status_code == 401
    response = client.post('/studio/podcasts', json=body, headers={'Authorization': 'Bearer ' + 'x' * 40})
    assert response.status_code == 404


def test_audio_route_does_not_serve_a_job_from_another_workspace(monkeypatch):
    import main
    monkeypatch.setenv('AI_SERVICE_TOKEN', 'x' * 40)
    class MissingJob:
        async def fetchrow(self, sql, job, workspace): return None
    async def pool(): return MissingJob()
    monkeypatch.setattr(p, 'get_pool', pool)
    response = TestClient(main.app).get(f'/studio/podcasts/{uuid4()}/audio?workspace_id={uuid4()}',
                                         headers={'Authorization': 'Bearer ' + 'x' * 40})
    assert response.status_code == 404
