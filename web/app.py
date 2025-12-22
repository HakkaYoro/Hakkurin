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

    return RedirectResponse(url="/?saved=true", status_code=303)

@app.get("/memories", response_class=HTMLResponse)
async def list_memories(request: Request):
    summary_dir = "data/memory/summaries"
    memories = []
    if os.path.exists(summary_dir):
        for filename in os.listdir(summary_dir):
            if filename.endswith(".txt"):
                user_id = filename.replace(".txt", "")
                # Intentar obtener fecha de modificación
                mod_time = os.path.getmtime(os.path.join(summary_dir, filename))
                from datetime import datetime
                date_str = datetime.fromtimestamp(mod_time).strftime('%Y-%m-%d %H:%M:%S')
                memories.append({"user_id": user_id, "date": date_str})
    
    return templates.TemplateResponse("memories.html", {
        "request": request,
        "memories": memories
    })

@app.get("/memories/{user_id}", response_class=HTMLResponse)
async def view_memory(request: Request, user_id: str):
    file_path = f"data/memory/summaries/{user_id}.txt"
    content = "No se encontró memoria para este usuario."
    if os.path.exists(file_path):
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
            
    return templates.TemplateResponse("memory_view.html", {
        "request": request,
        "user_id": user_id,
        "content": content
    })

def run_web_server():
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
