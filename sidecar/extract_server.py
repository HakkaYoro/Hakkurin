"""Sidecar yt-dlp — puerto NestJS llama aquí para extraer info de YouTube.

GET /extract?url=<video-or-search>&stream=1
  -> {"stream_url": ..., "title": ..., "uploader": ...}  (stream=True, sin descargar)
POST /extract  body {"url": ..., "stream": true}
  -> idem

Sin autenticación; pensado para correr en la red interna del compose junto al bot.
 ponytail: no descarga, solo extrae la URL directa de stream (igual que
 music_manager.py:43-51 con stream=True). ffmpeg corre del lado de @discordjs/voice.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import urllib.request
from typing import Any

import yt_dlp
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

YTDL_OPTS = {
    "format": "bestaudio/best",
    "noplaylist": True,
    "nocheckcertificate": True,
    "quiet": True,
    "no_warnings": True,
    "default_search": "auto",  # acepta strings de búsqueda, no solo URLs
    "source_address": "0.0.0.0",
    # ponytail: android esquiva el bot-check 429 de YouTube (el cliente web lo
    # recibe desde ~2026). Si android se bloquea algún día, upgrade path: cookies
    # (cookiefile) o player_client=["android","web"].
    "extractor_args": {"youtube": {"player_client": ["android"]}},
}

app = FastAPI(title="hakkurin yt-dlp sidecar")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


class ExtractIn(BaseModel):
    url: str
    stream: bool = True


def _extract(url: str, stream: bool) -> dict[str, Any]:
    # stream=True => no descargar; devolver data['url'] (URL directa del audio).
    opts = {**YTDL_OPTS}
    if not stream:
        # rutas de descarga no se usan hoy, pero se respeta el flag.
        opts["outtmpl"] = "/tmp/hakkurin-ytdl/%(id)s.%(ext)s"

    try:
        with yt_dlp.YoutubeDL(opts) as ytdl:
            data = ytdl.extract_info(url, download=not stream)
    except yt_dlp.utils.DownloadError as e:
        raise HTTPException(status_code=502, detail=f"yt-dlp error: {e}")

    if data is None:
        raise HTTPException(status_code=404, detail="sin resultados")

    if "entries" in data:  # playlist / búsqueda → primera entrada
        entries = [e for e in data.get("entries", []) if e]
        if not entries:
            raise HTTPException(status_code=404, detail="playlist vacía")
        data = entries[0]

    stream_url = data.get("url") if stream else data.get("_filename") or data.get("filepath")
    if not stream_url:
        # algunos extractores guardan la URL en formats[]; tomar la mejor.
        fmts = data.get("formats") or []
        best = None
        for f in fmts:
            if f.get("acode") != "none" and f.get("vcodec") != "none":
                continue
            best = f
        stream_url = (best or {}).get("url")

    if not stream_url:
        raise HTTPException(status_code=500, detail="no se resolvió URL de stream")

    return {
        "stream_url": stream_url,
        "title": data.get("title", "Unknown"),
        "uploader": data.get("uploader") or data.get("channel") or "Unknown",
        "duration": data.get("duration"),
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# --- Auto-actualización (el bot decide CUÁNDO; el sidecar solo obedece) ---
# El bucle horario vive en el bot (ytdl-updater.service.ts) porque el estado
# "está reproduciendo algo" es suyo. Aquí: consultar versión, actualizar pip y
# salir para que compose (restart: unless-stopped) levante el proceso fresco.

PYPI_JSON_URL = "https://pypi.org/pypi/yt-dlp/json"


def _latest_version() -> str | None:
    try:
        with urllib.request.urlopen(PYPI_JSON_URL, timeout=10) as res:
            return json.load(res).get("info", {}).get("version")
    except Exception:
        return None


def _die_soon() -> None:
    # Respuesta sale primero; el proceso muere después (os._exit no deja que
    # uvicorn/starlette lo capture como sys.exit). compose lo reinicia.
    threading.Timer(1.0, lambda: os._exit(0)).start()


@app.get("/version")
def version() -> dict[str, Any]:
    return {"installed": yt_dlp.version.__version__, "latest": _latest_version()}


@app.post("/update")
def update() -> dict[str, Any]:
    """pip install -U yt-dlp y salida limpia → contenedor reinicia con el paquete
    nuevo. Sin re-buildear imagen. Si pip falla: 500 y el proceso sigue vivo
    (sin crash-loop). El bot solo llama aquí con nada reproduciéndose."""
    global _updating
    _updating = True
    try:
        proc = subprocess.run(
            ["pip", "install", "--no-cache-dir", "--upgrade", "yt-dlp"],
            capture_output=True, text=True, timeout=300,
        )
    finally:
        # Matar pip a medias con /reset dejaría site-packages inconsistente →
        # crash-loop al arrancar. Mientras se instala, /reset no hace nada.
        _updating = False
    if proc.returncode != 0:
        raise HTTPException(status_code=500, detail=f"pip falló: {proc.stderr[-400:]}")
    _die_soon()
    return {"status": "updated", "version": yt_dlp.version.__version__}


_updating = False


@app.post("/reset")
def reset() -> dict[str, str]:
    """Mata el proceso (compose lo reinicia). /stop del bot lo llama para
    garantizar estado fresco de yt-dlp aunque un extract quede wedged.
    No-op mientras hay un pip en curso (ver /update)."""
    if _updating:
        return {"status": "busy"}
    _die_soon()
    return {"status": "resetting"}


@app.get("/extract")
def extract_get(url: str = Query(...), stream: bool = True) -> dict[str, Any]:
    return _extract(url, stream)


@app.post("/extract")
def extract_post(body: ExtractIn) -> dict[str, Any]:
    return _extract(body.url, body.stream)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "7654"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
