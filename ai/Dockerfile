FROM python:3.11-slim
WORKDIR /app
# tesseract-ocr: reads text from uploaded images.
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY requirements-podcast.txt .
# Podcastfy's older LangChain/NumPy constraints stay out of the AI service environment.
RUN python -m venv /opt/podcast && /opt/podcast/bin/pip install --no-cache-dir -r requirements-podcast.txt
ENV PODCAST_PYTHON=/opt/podcast/bin/python
COPY . .
# Run unprivileged, as uid 1000 like the backend, so both can use the shared /app/uploads volume.
RUN useradd --uid 1000 --create-home app && mkdir -p /app/uploads \
    && mkdir -p /opt/podcast/lib/python3.11/site-packages/podcastfy/data/audio/tmp \
    && chown -R app:app /app/uploads /opt/podcast/lib/python3.11/site-packages/podcastfy/data
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)" || exit 1
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
