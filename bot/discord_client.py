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
        # Iniciar tarea de festividades
        self.check_holidays_task.start()

    async def on_ready(self):
        print(f'Conectado como {self.user} (ID: {self.user.id})')
        print('------')


    async def on_typing(self, channel, user, when):
        """Detecta cuando alguien está escribiendo."""
        if user.bot: return
        
        if channel.id not in self.typing_users:
            self.typing_users[channel.id] = set()
        
        self.typing_users[channel.id].add(user.id)
        
        # CANCELACIÓN POR TYPING (Solicitado por usuario)
        # Si alguien empieza a escribir, cancelamos cualquier generación en curso para esperar el nuevo mensaje.
        keys_to_remove = []
        for (t_channel_id, t_user_id), task in self.pending_tasks.items():
            if t_channel_id == channel.id:
                task.cancel()
                keys_to_remove.append((t_channel_id, t_user_id))
                print(f"Cancelada tarea en {channel.id} por typing de {user.name}")
        
        for k in keys_to_remove:
            del self.pending_tasks[k]
        
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
        
        # Verificar si el bot está "enganchado" en la conversación del canal (habló hace poco)
        is_channel_engaged = conversation_manager.get_channel_context(message.channel.id).is_bot_engaged()
        
        should_process = is_mentioned or is_reply or was_active or is_channel_engaged
        
        if not should_process:
            reply_prob = config.get("reply_probability", 0.01) # Reducido a 1% para evitar spam inicial
            if random.random() < reply_prob:
                should_process = True
                print(f"Trigger por probabilidad ({reply_prob}) para {message.author.display_name}")

        if should_process:
            # Activar sesión explícitamente
            session.activate()
            
            # DEBOUNCE LOGIC Y CANCELACIÓN POR INTERRUPCIÓN
            # Si alguien habla en el canal mientras el bot piensa, cancelamos para que re-evalúe con el nuevo contexto.
            channel_id = message.channel.id
            
            # Cancelar cualquier tarea pendiente en este canal (sea de quien sea)
            # Esto implementa la "cancelación automática" si siguen escribiendo
            keys_to_remove = []
            for (t_channel_id, t_user_id), task in self.pending_tasks.items():
                if t_channel_id == channel_id:
                    task.cancel()
                    keys_to_remove.append((t_channel_id, t_user_id))
                    print(f"Cancelada tarea pendiente en {channel_id} por nuevo mensaje de {message.author.name}")
            
            for k in keys_to_remove:
                del self.pending_tasks[k]
            
            # Crear nueva tarea con delay (Cooldown 3s)
            key = (message.channel.id, message.author.id)
            task = asyncio.create_task(self.process_with_debounce(message, session, key))
            self.pending_tasks[key] = task

    async def process_with_debounce(self, message, session, key):
        try:
            # Esperar 3 segundos (Cooldown solicitado)
            await asyncio.sleep(3)
            
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
        
        # PROCESAR IMÁGENES (Multimodal)
        image_data = None
        image_mime_type = None
        
        if message.attachments:
            for attachment in message.attachments:
                # Filtrar por extensiones permitidas y tamaño razonable (< 4MB para no saturar)
                if any(attachment.filename.lower().endswith(ext) for ext in ['.png', '.jpg', '.jpeg', '.webp']):
                    try:
                        print(f"Descargando imagen: {attachment.filename}")
                        image_data = await attachment.read()
                        image_mime_type = attachment.content_type or "image/jpeg"
                        break # Solo procesamos la primera imagen por ahora
                    except Exception as e:
                        print(f"Error descargando imagen: {e}")

        # Análisis de IA
        analysis = await brain.analyze_interaction(
            user_text, 
            mem_summary, 
            channel_history, # Pasamos el historial global
            is_session_active=session.is_active,
            image_data=image_data,
            image_mime_type=image_mime_type
        )
        
        print(f"Análisis para {user_name}: {analysis}")

        # Decisión basada en intención
        intent = analysis.get("intent", "ignore")
        response_content = analysis.get("response_content", [])
        is_talking_to_me = analysis.get("is_talking_to_me", False)
        reply_to_id = analysis.get("reply_to_message_id")
        ping_users = analysis.get("ping_users", [])

        # Verificar si el bot está "enganchado" en la conversación del canal
        is_channel_engaged = conversation_manager.get_channel_context(message.channel.id).is_bot_engaged()

        # Normalizar a lista si por alguna razón llega string
        if isinstance(response_content, str):
            # Intentar corregir si es un string que parece una lista "['a', 'b']"
            response_content = response_content.strip()
            if response_content.startswith("[") and response_content.endswith("]"):
                try:
                    import ast
                    parsed = ast.literal_eval(response_content)
                    if isinstance(parsed, list):
                        response_content = parsed
                    else:
                        response_content = [response_content]
                except:
                    # Si falla el eval, asumimos que es un string normal con corchetes
                    response_content = [response_content]
            else:
                response_content = [response_content]
        
        # Segunda pasada de limpieza: Si la lista contiene strings que parecen listas "['texto']"
        # Esto corrige el bug visual reportado
        final_content = []
        for item in response_content:
            if isinstance(item, str) and item.startswith("[") and item.endswith("]"):
                 try:
                    import ast
                    parsed = ast.literal_eval(item)
                    if isinstance(parsed, list):
                        final_content.extend(parsed)
                    else:
                        final_content.append(item)
                 except:
                    final_content.append(item)
            else:
                final_content.append(item)
        response_content = final_content

        # Actualizar estado de sesión según si nos hablan
        if not is_talking_to_me and session.is_active:
            pass 
        
        if intent in ["reply", "complain", "new_topic"] and response_content:
            async with message.channel.typing():
                # Delay inicial de "lectura" y "pensamiento"
                await asyncio.sleep(random.uniform(0.5, 1.5))

            full_response_text = ""
            
            # Preparar referencia de mensaje si la IA lo pidió
            reference = None
            if reply_to_id:
                try:
                    # Intentar buscar el mensaje, aunque puede ser viejo
                    # Discord.py permite pasar un MessageReference o un Message object
                    # Si tenemos el ID, creamos una referencia simple
                     reference = discord.MessageReference(message_id=int(reply_to_id), channel_id=message.channel.id)
                except:
                    pass
            elif is_talking_to_me and not is_channel_engaged: 
                 # Si me hablan directo y no es charla grupal fluida, por defecto respondo al mensaje original
                 # A MENOS que sea charla fluida, donde el reply a veces molesta.
                 # El usuario pidió "marcar mensajes", así que priorizamos lo que diga la IA.
                 reference = message 

            # Procesar pings
            ping_text = ""
            if ping_users:
                for uid in ping_users:
                    ping_text += f"<@{uid}> "

            for i, msg_text in enumerate(response_content):
                if not msg_text: continue
                
                # Añadir pings al primer mensaje
                if i == 0 and ping_text:
                    msg_text = ping_text + msg_text

                # Calcular tiempo de escritura: ~0.05s por caracter, mínimo 0.5s, máximo 4s
                typing_time = min(max(len(msg_text) * 0.08, 0.5), 4.0)
                
                async with message.channel.typing():
                    await asyncio.sleep(typing_time)
                    # Usar referencia solo en el primer mensaje si existe
                    if i == 0 and reference:
                        try:
                            await message.channel.send(msg_text, reference=reference)
                        except:
                             await message.channel.send(msg_text) # Fallback si el mensaje se borró
                    else:
                        await message.channel.send(msg_text)
                
                full_response_text += msg_text + " "
                # Pequeña pausa entre mensajes
                await asyncio.sleep(random.uniform(0.2, 0.5))
            
            # Añadir respuesta completa al contexto GLOBAL
            channel_ctx = conversation_manager.get_channel_context(message.channel.id)
            channel_ctx.add_message(config.get('bot_name'), str(self.user.id), full_response_text.strip())
            channel_ctx.update_bot_activity() # Marcar que el bot está activo en este canal
            
            # Guardar último canal conocido para festividades
            memory.update_last_channel(user_id, message.channel.id)

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

    @tasks.loop(seconds=60)
    async def check_holidays_task(self):
        """Revisa si es momento de celebrar una festividad."""
        from datetime import datetime, timezone, timedelta
        import json
        import os

        # Hora actual GMT-4
        tz = timezone(timedelta(hours=-4))
        now = datetime.now(tz)
        
        # Archivo de persistencia de festividades
        HOLIDAY_FILE = "data/holidays.json"
        if not os.path.exists(HOLIDAY_FILE):
            with open(HOLIDAY_FILE, "w") as f: json.dump({}, f)
        
        try:
            with open(HOLIDAY_FILE, "r") as f:
                holiday_data = json.load(f)
        except:
            holiday_data = {}

        # Definir eventos: (mes, dia, hora, minuto, key_name, holiday_display_name)
        # Navidad: 25 Dic 00:01
        # Año Nuevo: 1 Ene 00:00 (El usuario dijo 00:00:01, chequeamos minuto 0)
        events = [
            (12, 25, 0, 1, "xmas", "Navidad"),
            (1, 1, 0, 0, "newyear", "Año Nuevo")
        ]

        current_year = str(now.year)

        for month, day, hour, minute, key, name in events:
            if now.month == month and now.day == day and now.hour == hour and now.minute == minute:
                event_key = f"{key}_{current_year}"
                
                if event_key not in holiday_data:
                    print(f"¡Es {name}! Iniciando celebración global...")
                    # Marcar como enviado para no repetir en el mismo minuto
                    holiday_data[event_key] = True
                    with open(HOLIDAY_FILE, "w") as f: json.dump(holiday_data, f)
                    
                    await self.celebrate_holiday(name)

    async def celebrate_holiday(self, holiday_name):
        """Envía mensajes festivos a todos los usuarios conocidos."""
        users = memory.get_all_users_data()
        print(f"Enviando felicitaciones de {holiday_name} a {len(users)} usuarios...")
        
        for user_data in users:
            uid = user_data['user_id']
            channel_id = user_data['last_channel_id']
            summary = user_data['summary']
            
            if not channel_id: continue
            
            try:
                channel = self.get_channel(int(channel_id))
                if not channel: continue

                # Generar mensaje personalizado
                msg_text = await brain.generate_holiday_greeting(summary, holiday_name)
                
                # Añadir ping
                full_msg = f"<@{uid}> {msg_text}"
                
                await channel.send(full_msg)
                print(f"Felicitación enviada a {uid} en {channel_id}")
                
                # Evitar rate limits masivos
                await asyncio.sleep(random.uniform(2, 5))
                
            except Exception as e:
                print(f"Error felicitando a {uid}: {e}")

# Instancia global eliminada para evitar errores de reinicio
# bot_client = HakkurinBot()
