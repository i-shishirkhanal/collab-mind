FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# Run unprivileged, as uid 1000 like the backend, so both can use the shared /app/uploads volume.
RUN useradd --uid 1000 --create-home app && mkdir -p /app/uploads && chown app:app /app/uploads
USER app
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
