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
        # run() es bloqueante, así que cuando termine (por self.close()), la función retornará
        bot_client.run(token)
        return True
    except Exception as e:
        logger.error(f"Error al iniciar el bot: {e}")
        return False

# Variable global para controlar el reinicio
should_restart = False

def restart_system():
    """Llamado desde la WebUI para reiniciar el bot."""
    global should_restart
    should_restart = True
    logger.info("Solicitud de reinicio recibida. Deteniendo bot...")
    
    # Programar el cierre del bot en su propio event loop
    if bot_client.loop and bot_client.loop.is_running():
        asyncio.run_coroutine_threadsafe(bot_client.force_shutdown_and_summarize(), bot_client.loop)

if __name__ == "__main__":
    logger.info("Iniciando Hakkurin System...")
    
    # Iniciar WebUI en un hilo separado
    # Pasamos la función de reinicio a la app web (un poco hacky pero funciona simple)
    import web.app
    web.app.set_restart_callback(restart_system)
    
    web_thread = threading.Thread(target=run_web_server, daemon=True)
    web_thread.start()
    logger.info("WebUI iniciada en http://localhost:8000")

    while True:
        # Recargar configuración antes de cada inicio
        config.load_config()
        
        should_restart = False
        logger.info("Arrancando proceso del bot...")
        
        # Iniciar Bot (bloqueante)
        bot_started = run_bot()
        
        if not bot_started and not should_restart:
            logger.info("El bot no pudo iniciar y no se solicitó reinicio. Esperando configuración...")
            # Esperar activo hasta que alguien pida reinicio (por cambio de config)
            while not should_restart:
                time.sleep(1)
        
        if should_restart:
            logger.info("Reiniciando sistema en 3 segundos...")
            time.sleep(3)
            # El loop continuará y volverá a llamar a run_bot() con la nueva config
        else:
            # Si el bot se cerró por otra razón (crash o CTRL+C), salimos
            logger.info("Bot detenido sin solicitud de reinicio. Saliendo.")
            break
