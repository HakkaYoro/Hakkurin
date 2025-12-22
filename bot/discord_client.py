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
        intents.guilds = True # Necesario para typing events
        intents.members = True # Útil para nombres
        super().__init__(intents=intents)
        self.pending_tasks = {} # (channel_id, user_id) -> Task
        self.typing_users = {} # channel_id -> set(user_ids)

    async def setup_hook(self):
        # Iniciar tarea de fondo para timeouts
        self.check_timeouts_task.start()

    async def on_ready(self):
        print(f'Conectado como {self.user} (ID: {self.user.id})')
        print('------')

    async def on_typing(self, channel, user, when):
        """Detecta cuando alguien está escribiendo."""
        if user.bot: return
        
        if channel.id not in self.typing_users:
            self.typing_users[channel.id] = set()
        
        self.typing_users[channel.id].add(user.id)
        
        # Limpiar usuario del set después de 10 segundos (timeout de typing de Discord)
        await asyncio.sleep(10)
        if channel.id in self.typing_users and user.id in self.typing_users[channel.id]:
            self.typing_users[channel.id].discard(user.id)

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

        # 1. Actualizar sesión y contexto global del canal
        # Ahora pasamos user_name y message_content para que se añada al historial global
        session = conversation_manager.create_or_update_session(
            message.channel.id, 
            message.author.id, 
            user_name=message.author.display_name,
            message_content=message.content
        )
        
        # Estado previo (si estaba activa antes de este mensaje)
        was_active = session.is_active
        
        # 2. Determinar Trigger
        is_mentioned = self.user in message.mentions
        is_reply = (message.reference and message.reference.cached_message and 
                    message.reference.cached_message.author == self.user)
        
        should_process = is_mentioned or is_reply or was_active
        
        if not should_process:
            reply_prob = config.get("reply_probability", 0.05)
            if random.random() < reply_prob:
                should_process = True
                print(f"Trigger por probabilidad ({reply_prob}) para {message.author.display_name}")

        if should_process:
            # Activar sesión explícitamente
            session.activate()
            
            # DEBOUNCE LOGIC
            # Usamos channel_id como key principal para el debounce global del canal si queremos evitar spam,
            # pero el usuario pidió debounce por usuario ("al hablar con un usuario").
            # Sin embargo, para multi-usuario fluido, si A habla y B habla, deberíamos procesar ambos.
            # Mantendremos debounce por usuario para no responder a cada línea de un mismo usuario.
            key = (message.channel.id, message.author.id)
            
            # Cancelar tarea pendiente si existe
            if key in self.pending_tasks:
                self.pending_tasks[key].cancel()
            
            # Crear nueva tarea con delay
            task = asyncio.create_task(self.process_with_debounce(message, session, key))
            self.pending_tasks[key] = task

    async def process_with_debounce(self, message, session, key):
        try:
            # Esperar 4 segundos (reducido de 8)
            await asyncio.sleep(4)
            
            # Verificar si alguien está escribiendo en el canal
            channel_id = message.channel.id
            if channel_id in self.typing_users and self.typing_users[channel_id]:
                # Si hay alguien escribiendo, esperamos un poco más (máximo 5s extra)
                # para ver si completan su idea y no interrumpir.
                print(f"Detectado typing en {channel_id}, esperando...")
                for _ in range(5):
                    if not self.typing_users.get(channel_id):
                        break
                    await asyncio.sleep(1)
            
            # Procesar
            await self.process_smart_response(message, session)
            
        except asyncio.CancelledError:
            pass
        finally:
            if key in self.pending_tasks and self.pending_tasks[key] == asyncio.current_task():
                del self.pending_tasks[key]

    async def process_smart_response(self, message, session):
        user_id = str(message.author.id)
        user_name = message.author.display_name
        user_text = message.content

        # Recuperar memoria
        mem_summary = memory.get_memory_summary(user_id)
        
        # OBTENER CONTEXTO DEL CANAL (GLOBAL)
        # Esto permite ver la conversación entre múltiples usuarios
        channel_history = conversation_manager.get_channel_context(message.channel.id).get_formatted_history()
        
        # Análisis de IA
        analysis = await brain.analyze_interaction(
            user_text, 
            mem_summary, 
            channel_history, # Pasamos el historial global
            is_session_active=session.is_active
        )
        
        print(f"Análisis para {user_name}: {analysis}")

        # Decisión basada en intención
        intent = analysis.get("intent", "ignore")
        response_content = analysis.get("response_content", [])
        is_talking_to_me = analysis.get("is_talking_to_me", False)

        # Normalizar a lista si por alguna razón llega string
        if isinstance(response_content, str):
            response_content = [response_content]

        # Actualizar estado de sesión según si nos hablan
        if not is_talking_to_me and session.is_active:
            pass 
        
        if intent in ["reply", "complain", "new_topic"] and response_content:
            async with message.channel.typing():
                # Delay inicial de "lectura" y "pensamiento"
                await asyncio.sleep(random.uniform(0.5, 1.5))

            full_response_text = ""
            
            for msg_text in response_content:
                if not msg_text: continue
                
                # Calcular tiempo de escritura: ~0.05s por caracter, mínimo 0.5s, máximo 4s
                typing_time = min(max(len(msg_text) * 0.08, 0.5), 4.0)
                
                async with message.channel.typing():
                    await asyncio.sleep(typing_time)
                    await message.channel.send(msg_text)
                
                full_response_text += msg_text + " "
                # Pequeña pausa entre mensajes
                await asyncio.sleep(random.uniform(0.2, 0.5))
            
            # Añadir respuesta completa al contexto GLOBAL
            conversation_manager.get_channel_context(message.channel.id).add_message(config.get('bot_name'), full_response_text.strip())
            
            # Actualizar memoria (fire and forget)
            asyncio.create_task(self.update_user_memory(user_id, user_name, user_text, full_response_text.strip()))
        
        elif intent == "ignore":
            print(f"Ignorando mensaje de {user_name} (Intención: ignore)")
            pass

    async def update_user_memory(self, user_id, user_name, user_text, bot_text):
        try:
            # Actualizar nombre si no existe
            current_mem = memory.get_memory(user_id)
            if not current_mem["profile"]["name"]:
                current_mem["profile"]["name"] = user_name
                memory.save_memory(user_id, current_mem)

            # Añadir interacción al buffer
            interaction_text = f"Usuario: {user_text}\nBot: {bot_text}"
            should_summarize = memory.add_interaction(user_id, interaction_text)
            
            if should_summarize:
                print(f"Iniciando resumen de memoria para {user_name}...")
                asyncio.create_task(self.perform_memory_summarization(user_id))
                
        except Exception as e:
            print(f"Error actualizando memoria: {e}")

    async def perform_memory_summarization(self, user_id):
        try:
            current_summary, buffer = memory.get_buffer_and_summary(user_id)
            if not buffer: return

            new_summary = await brain.generate_summary(current_summary, buffer)
            
            if new_summary:
                memory.update_summary(user_id, new_summary)
                print(f"Resumen de memoria actualizado para {user_id}")
        except Exception as e:
            print(f"Error en proceso de resumen: {e}")

    async def force_shutdown_and_summarize(self):
        """Fuerza el resumen de todos los usuarios pendientes y cierra el bot."""
        print("Iniciando apagado controlado con resumen forzado...")
        pending_users = memory.get_users_with_pending_buffer()
        
        if pending_users:
            print(f"Resumiendo memorias para {len(pending_users)} usuarios...")
            tasks = [self.perform_memory_summarization(uid) for uid in pending_users]
            await asyncio.gather(*tasks)
            print("Todos los resúmenes completados.")
        
        print("Cerrando conexión con Discord...")
        await self.close()

# Instancia global
bot_client = HakkurinBot()
