import asyncio
import os
import sys
import threading
from dotenv import load_dotenv

# Cargar variables de entorno si existen
load_dotenv()

from core.config_manager import config
from bot.discord_client import bot_client
from web.app import run_web_server

def run_bot():
    token = config.get("bot_token")
    if not token or token == "TU_TOKEN_DE_DISCORD_AQUI":
        print("ADVERTENCIA: Token de Discord no configurado. El bot no iniciará sesión.")
        print("Ve a http://localhost:8000 para configurarlo.")
        return

    try:
        bot_client.run(token)
    except Exception as e:
        print(f"Error al iniciar el bot: {e}")

if __name__ == "__main__":
    print("Iniciando Hakkurin System...")
    
    # Iniciar WebUI en un hilo separado
    web_thread = threading.Thread(target=run_web_server, daemon=True)
    web_thread.start()
    print("WebUI iniciada en http://localhost:8000")

    # Iniciar Bot en el hilo principal
    run_bot()
