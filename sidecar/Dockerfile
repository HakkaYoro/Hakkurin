# Sidecar yt-dlp: el bot NestJS llama a http://sidecar:7654/extract?url= para
# resolver la URL directa de stream de YouTube. Sin descarga (stream=True),
# así que no necesita ffmpeg — sólo extrae metadatos/URL.
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY extract_server.py ./
EXPOSE 7654
CMD ["uvicorn", "extract_server:app", "--host", "0.0.0.0", "--port", "7654"]
