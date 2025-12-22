from fastapi import FastAPI, Request, Form
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, RedirectResponse
import uvicorn
from core.config_manager import config
import os

app = FastAPI()

# Configurar templates
templates = Jinja2Templates(directory="web/templates")

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {
        "request": request,
        "config": config.config
    })

restart_callback = None

def set_restart_callback(callback):
    global restart_callback
    restart_callback = callback

@app.post("/restart")
async def restart_bot(request: Request):
    if restart_callback:
        restart_callback()
        return RedirectResponse(url="/?restarted=true", status_code=303)
    return HTMLResponse("Error: No restart callback set", status_code=500)

@app.post("/update_config")
async def update_config(
    request: Request,
    bot_name: str = Form(...),
    bot_token: str = Form(...),
    system_prompt: str = Form(...),
    reply_probability: float = Form(...),
    developer_id: str = Form(...),
    gemini_keys: str = Form(...) # Recibiremos las keys como texto separado por líneas
):
    # Procesar keys
    keys_list = [k.strip() for k in gemini_keys.split('\n') if k.strip()]
    
    # Actualizar configuración
    config.set("bot_name", bot_name)
    config.set("bot_token", bot_token)
    config.set("system_prompt", system_prompt)
    config.set("reply_probability", reply_probability)
    config.set("developer_id", developer_id)
    config.set("gemini_keys", keys_list)
    
    return RedirectResponse(url="/?saved=true", status_code=303)

def run_web_server():
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
