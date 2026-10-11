# Local embeddings troubleshooting

The `embeddings` Compose profile starts BGE-M3, but it does not automatically point the AI service at that endpoint.

## Configure the bundled server

1. Complete the required values in the root `.env` as described in the README.
2. Set `EMBEDDING_BASE_URL=http://embeddings:80/v1` in that file. The hostname `embeddings` resolves inside the Compose network.
3. Run from the repository root:

```bash
docker compose --profile embeddings up --build
```

The first start downloads approximately 2.3 GB of model weights. Wait for the embedding server to finish loading before uploading documents or asking retrieval questions.

## Diagnose indexing or retrieval failures

```bash
docker compose --profile embeddings ps
docker compose --profile embeddings logs --tail=100 embeddings ai
```

- If the embeddings service is absent, restart with `--profile embeddings`.
- If the AI service reports an unconfigured embedding endpoint, check `EMBEDDING_BASE_URL` and recreate the AI container after changing `.env`:

```bash
docker compose --profile embeddings up -d --force-recreate ai
```

- If the server is still downloading or loading the model, wait for startup to finish and retry.
- For a hosted embedding endpoint, configure its URL and credentials in `.env`; the bundled profile is unnecessary.

Do not use `localhost` as the AI container's URL for the bundled server: that address refers to the AI container itself. Keep the configured model and dimension consistent (`BAAI/bge-m3`, `1024`) with the database embeddings.

See [model and retrieval configuration](phase3-ai-models-rag.md) and the root [`docker-compose.yml`](../docker-compose.yml).
