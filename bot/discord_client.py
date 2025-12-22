import discord
import random
import asyncio
from discord.ext import tasks
from core.config_manager import config
from core.ai_handler import brain
from core.memory_manager import memory
from core.conversation_manager import conversation_manager

class HakkurinBot(discord.Client):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True
        super().__init__(intents=intents)

    async def setup_hook(self):
        # Iniciar tarea de fondo para timeouts
        self.check_timeouts_task.start()

    async def on_ready(self):
        print(f'Conectado como {self.user} (ID: {self.user.id})')
        print('------')

    @tasks.loop(seconds=60)
    async def check_timeouts_task(self):
        """Revisa sesiones expiradas cada minuto."""
        await conversation_manager.check_timeouts(self.send_message_callback)

    async def send_message_callback(self, channel_id, text):
        """Callback para que el manager pueda enviar mensajes."""
        try:
            channel = self.get_channel(channel_id)
            if channel:
                async with channel.typing():
                    await asyncio.sleep(random.uniform(1, 3)) # Delay humano
                    await channel.send(text)
        except Exception as e:
            print(f"Error enviando mensaje callback a {channel_id}: {e}")

    async def on_message(self, message):
        if message.author.bot:
            return

        allowed_channels = config.get("allowed_channels", [])
        if allowed_channels and message.channel.id not in allowed_channels:
            return

        # 1. Gestión de Sesión
        session = conversation_manager.create_or_update_session(message.channel.id, message.author.id)
        session.add_context(f"Usuario: {message.content}")

        # 2. Determinar Trigger
        is_mentioned = self.user in message.mentions
        is_reply = (message.reference and message.reference.cached_message and 
                    message.reference.cached_message.author == self.user)
        
        # Si la sesión está activa (reciente), asumimos que nos hablan, 
        # PERO la IA confirmará con "is_talking_to_me".
        # Si NO está activa, usamos probabilidad o mención.
        should_process = is_mentioned or is_reply or session.is_active
        
        if not should_process:
            reply_prob = config.get("reply_probability", 0.125)
            if random.random() < reply_prob:
                should_process = True

        if should_process:
            async with message.channel.typing():
                await self.process_smart_response(message, session)

    async def process_smart_response(self, message, session):
        user_id = str(message.author.id)
        user_name = message.author.display_name
        user_text = message.content

        # Recuperar memoria
        mem_summary = memory.get_memory_summary(user_id)
        
        # Análisis de IA
        analysis = await brain.analyze_interaction(
            user_text, 
            mem_summary, 
            session.context_messages, 
            is_session_active=session.is_active
        )
        
        print(f"Análisis para {user_name}: {analysis}")

        # Decisión basada en intención
        intent = analysis.get("intent", "ignore")
        response_text = analysis.get("response_content", "")
        is_talking_to_me = analysis.get("is_talking_to_me", False)

        # Actualizar estado de sesión según si nos hablan
        if not is_talking_to_me and session.is_active:
            # Si estábamos hablando y de repente hablan de otra cosa, 
            # la IA puede decidir ignorar o quejarse.
            # Si decide ignorar, incrementamos contador o cerramos sesión si es mucho.
            pass # La lógica de timeout se encargará si dejan de hablarle directamente
        
        if intent in ["reply", "complain", "new_topic"] and response_text:
            # Delay humano variable según longitud
            delay = min(len(response_text) * 0.05, 3.0)
            await asyncio.sleep(delay)
            
            await message.reply(response_text, mention_author=False)
            
            # Añadir nuestra respuesta al contexto
            session.add_context(f"{config.get('bot_name')}: {response_text}")
            
            # Actualizar memoria (fire and forget)
            asyncio.create_task(self.update_user_memory(user_id, user_name, user_text, response_text))
        
        elif intent == "ignore":
            print(f"Ignorando mensaje de {user_name} (Intención: ignore)")
            # Si nos ignoran explícitamente, podríamos cerrar la sesión para no gastar recursos
            if not is_talking_to_me:
                # Opcional: conversation_manager.end_session(message.channel.id, message.author.id)
                pass

    async def update_user_memory(self, user_id, user_name, user_text, bot_text):
        try:
            current_mem = memory.get_memory(user_id)
            if not current_mem["profile"]["name"]:
                current_mem["profile"]["name"] = user_name
            current_mem["interaction_count"] += 1
            memory.save_memory(user_id, current_mem)
        except Exception as e:
            print(f"Error actualizando memoria: {e}")

# Instancia global
bot_client = HakkurinBot()
