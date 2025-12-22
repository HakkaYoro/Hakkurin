import asyncio
import os
import sys
import threading
import time
import logging
from logging.handlers import RotatingFileHandler
from dotenv import load_dotenv

# Configuración de Logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        RotatingFileHandler("hakkurin.log", maxBytes=5*1024*1024, backupCount=3, encoding='utf-8'),
        logging.StreamHandler(sys.stdout)
    ]
)

logger = logging.getLogger("Main")

# Cargar variables de entorno si existen
load_dotenv()

from core.config_manager import config
from bot.discord_client import bot_client
from web.app import run_web_server

def run_bot():
    token = config.get("bot_token")
    if not token or token == "TU_TOKEN_DE_DISCORD_AQUI":
        logger.warning("Token de Discord no configurado. El bot no iniciará sesión.")
        logger.info("Ve a http://localhost:8000 para configurarlo.")
        return False

    try:
        logger.info("Intentando iniciar cliente de Discord...")
        bot_client.run(token)
        return True
    except Exception as e:
        logger.error(f"Error al iniciar el bot: {e}")
        return False

if __name__ == "__main__":
    logger.info("Iniciando Hakkurin System...")
    
    # Iniciar WebUI en un hilo separado
    web_thread = threading.Thread(target=run_web_server, daemon=True)
    web_thread.start()
    logger.info("WebUI iniciada en http://localhost:8000")

    # Iniciar Bot en el hilo principal
    bot_started = run_bot()
    
    if not bot_started:
        logger.info("El bot no pudo iniciar. Manteniendo proceso vivo para la WebUI...")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            logger.info("Apagando sistema...")
