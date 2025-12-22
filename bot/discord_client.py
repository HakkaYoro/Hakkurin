import discord
import random
import asyncio
from core.config_manager import config
from core.ai_handler import brain
from core.memory_manager import memory

class HakkurinBot(discord.Client):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True
        super().__init__(intents=intents)

    async def on_ready(self):
        print(f'Conectado como {self.user} (ID: {self.user.id})')
        print('------')

    async def on_message(self, message):
        # Ignorar mensajes propios o de otros bots
        if message.author.bot:
            return

        # Verificar canales permitidos (si la lista no está vacía)
        allowed_channels = config.get("allowed_channels", [])
        if allowed_channels and message.channel.id not in allowed_channels:
            return

        is_mentioned = self.user in message.mentions
        is_reply = (message.reference and message.reference.cached_message and 
                    message.reference.cached_message.author == self.user)
        
        # Probabilidad de respuesta aleatoria (1/8 por defecto)
        reply_prob = config.get("reply_probability", 0.125)
        should_reply_randomly = random.random() < reply_prob

        if is_mentioned or is_reply or should_reply_randomly:
            async with message.channel.typing():
                await self.process_response(message)

    async def process_response(self, message):
        user_id = str(message.author.id)
        user_name = message.author.display_name
        user_text = message.content

        # 1. Recuperar memoria
        mem_summary = memory.get_memory_summary(user_id)
        
        # 2. Generar respuesta con IA
        # Contexto simple: últimos 3 mensajes del canal (opcional, por ahora solo el actual)
        response_text = await brain.generate_response(user_text, mem_summary)

        # 3. Enviar respuesta
        if response_text:
            sent_msg = await message.reply(response_text, mention_author=False)
            
            # 4. Actualizar memoria en background (fire and forget)
            asyncio.create_task(self.update_user_memory(user_id, user_name, user_text, response_text))

    async def update_user_memory(self, user_id, user_name, user_text, bot_text):
        """
        Analiza la interacción y actualiza la memoria del usuario.
        Esto podría ser otra llamada a la IA para extraer datos.
        """
        try:
            current_mem = memory.get_memory(user_id)
            
            # Actualizar nombre si no está
            if not current_mem["profile"]["name"]:
                current_mem["profile"]["name"] = user_name
            
            current_mem["interaction_count"] += 1
            
            # Aquí podríamos llamar a la IA para resumir, por ahora solo guardamos notas simples
            # Para una implementación real "inteligente", haríamos:
            # new_notes = await brain.analyze_interaction(user_text, current_mem)
            # current_mem["notes"] = new_notes
            
            # Guardar cambios
            memory.save_memory(user_id, current_mem)
            
        except Exception as e:
            print(f"Error actualizando memoria de {user_id}: {e}")

# Instancia global para ser llamada desde main
bot_client = HakkurinBot()
