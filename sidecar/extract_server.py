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

import os
import re
import sys
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
