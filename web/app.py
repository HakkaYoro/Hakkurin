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
    return templates.TemplateResponse(request, "index.html", {
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
    gemini_keys: str = Form(...), # Recibiremos las keys como texto separado por líneas
    nanogpt_api_key: str = Form("") # Opcional
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
    if nanogpt_api_key and nanogpt_api_key.strip():
        config.set("nanogpt_api_key", nanogpt_api_key.strip())
    
    return RedirectResponse(url="/?saved=true", status_code=303)

from core.memory_manager import memory

@app.get("/memories", response_class=HTMLResponse)
async def list_memories(request: Request):
    # Usar el directorio real de memorias encriptadas
    memory_dir = "data/memory/users"
    memories = []
    
    if os.path.exists(memory_dir):
        for filename in os.listdir(memory_dir):
            if filename.endswith(".enc"):
                user_id = filename.replace(".enc", "")
                
                # Obtener fecha de modificación del archivo
                file_path = os.path.join(memory_dir, filename)
                mod_time = os.path.getmtime(file_path)
                from datetime import datetime
                date_str = datetime.fromtimestamp(mod_time).strftime('%Y-%m-%d %H:%M:%S')
                
                mem_data = {"user_id": user_id, "date": date_str}
                
                # Marcar si es la memoria interna
                if user_id == memory.BOT_SELF_ID:
                    mem_data["is_self"] = True
                    
                memories.append(mem_data)
    
    # Ordenar por fecha reciente
    memories.sort(key=lambda x: x["date"], reverse=True)
    
    return templates.TemplateResponse(request, "memories.html", {
        "memories": memories
    })

@app.get("/memories/{user_id}", response_class=HTMLResponse)
async def view_memory(request: Request, user_id: str):
    # Usar MemoryManager para desencriptar
    try:
        if user_id == memory.BOT_SELF_ID:
            content = memory.get_self_memory()
        else:
            summary = memory.get_memory_summary(user_id)
            content = summary if summary else "Sin resumen generado aún."
    except Exception as e:
        content = f"Error leyendo memoria: {str(e)}"
            
    return templates.TemplateResponse(request, "memory_view.html", {
        "user_id": user_id,
        "content": content
    })

def run_web_server():
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
