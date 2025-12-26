import asyncio
import unittest
from unittest.mock import MagicMock, AsyncMock, patch
import sys
import os

# Añadir directorio raíz al path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bot.discord_client import HakkurinBot
import discord

async def run_simulation():
    print("--- SIMULACION DE LOGGING DM ---")

    # 1. Mockear dependencias externas para evitar llamadas reales
    with patch('bot.discord_client.brain') as mock_brain, \
         patch('bot.discord_client.memory') as mock_memory, \
         patch('bot.discord_client.conversation_manager') as mock_cm:

        # Configurar Mock del Brain para devolver una respuesta fija
        mock_brain.analyze_interaction = AsyncMock(return_value={
            "intent": "reply",
            "response_content": ["Hola, esto es una prueba."],
            "is_talking_to_me": True
        })

        # Configurar Mock del Conversation Manager
        mock_session = MagicMock()
        mock_session.is_active = True
        mock_cm.create_or_update_session.return_value = mock_session
        mock_cm.get_channel_context.return_value.is_bot_engaged.return_value = False
        mock_cm.get_channel_context.return_value.get_recent_images.return_value = []

        # 2. Instanciar el bot (sin conectar a Discord)
        bot = HakkurinBot()
        
        # 3. Crear objetos Mock de Discord
        mock_user = MagicMock(spec=discord.User)
        mock_user.id = 123456789
        mock_user.name = "TestUser"
        mock_user.display_name = "TestUser"
        mock_user.bot = False

        mock_channel = MagicMock(spec=discord.DMChannel)
        mock_channel.id = 987654321
        # Importante: para que isinstance(ch, discord.DMChannel) funcione, 
        # el mock debe tener la clase correcta o usarse side_effect/spec.
        # Pero MagicMock(spec=discord.DMChannel) a veces falla con isinstance si la clase no es base.
        # Forzamos __class__ para el chequeo de isinstance
        mock_channel.__class__ = discord.DMChannel
        
        # Mockear typing context manager
        # typing() retorna un objeto que es un async context manager
        mock_typing_cm = MagicMock()
        mock_typing_cm.__aenter__ = AsyncMock(return_value=None)
        mock_typing_cm.__aexit__ = AsyncMock(return_value=None)
        mock_channel.typing.return_value = mock_typing_cm
        
        mock_channel.send = AsyncMock()

        mock_message = MagicMock(spec=discord.Message)
        mock_message.author = mock_user
        mock_message.channel = mock_channel
        mock_message.content = "Hola bot, ¿estás ahí?"
        mock_message.guild = None # DM no tiene guild
        mock_message.attachments = []
        mock_message.mentions = [] # SIN MENCIONES
        mock_message.reference = None

        # 4. Ejecutar on_message
        print("\n>>> Enviando mensaje simulado (SIN MENCION)...")
        await bot.on_message(mock_message)
        
        # Esperar un poco a que las tareas asíncronas terminen (debounce, etc)
        # El bot usa create_task para process_with_debounce, así que necesitamos esperar
        print(">>> Esperando procesamiento...")
        await asyncio.sleep(4) # 3s debounce + 1s buffer
        
        # Verificar que se llamó a analyze_interaction con is_dm=True
        if mock_brain.analyze_interaction.called:
             args, kwargs = mock_brain.analyze_interaction.call_args
             if kwargs.get('is_dm') is True:
                 print(">>> EXITO: El mensaje fue procesado como DM (is_dm=True).")
             else:
                 print(f">>> FALLO: is_dm no es True. Kwargs: {kwargs}")
        else:
             print(">>> FALLO: El mensaje NO fue procesado.")

    print("\n--- FIN SIMULACION ---")

if __name__ == "__main__":
    asyncio.run(run_simulation())
