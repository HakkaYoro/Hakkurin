import discord
from discord import app_commands
import random
import asyncio
from discord.ext import tasks
from core.config_manager import config
from core.ai_handler import brain
from core.memory_manager import memory
from core.conversation_manager import conversation_manager
from core.scheduler import scheduler
from bot.music_manager import MusicManager

class HakkurinBot(discord.Client):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True
        intents.guilds = True # Necesario para typing events
        intents.members = True # Útil para nombres
        super().__init__(intents=intents)
        self.pending_tasks = {} # (channel_id, user_id) -> Task
        self.typing_users = {} # channel_id -> set(user_ids)
        
        # Inicializar estado de sueño
        self.is_sleeping = False
        self.sleep_until = 0
        self.last_active_channel_id = None
        self._load_status_messages()
        
        # Cache para evitar repetir acciones muy seguido
        self.executed_actions_cache = {}
        
        # Inicializar gestor de música
        self.music_manager = MusicManager(self)
        
        # Inicializar Command Tree para Slash Commands
        self.tree = app_commands.CommandTree(self)
        
        # Definir Slash Commands
        @self.tree.command(name="play", description="Reproduce música desde una URL de YouTube")
        @app_commands.describe(url="La URL del video o canción a reproducir")
        async def play_command(interaction: discord.Interaction, url: str):
            await self.music_manager.play(interaction, url)
            
        @self.tree.command(name="skip", description="Vota para saltar la canción actual")
        async def skip_command(interaction: discord.Interaction):
            await self.music_manager.skip(interaction)
            
        @self.tree.command(name="stop", description="Detiene la música y desconecta al bot")
        async def stop_command(interaction: discord.Interaction):
            await self.music_manager.stop(interaction)
            
        @self.tree.command(name="queue", description="Muestra la cola de reproducción actual")
        async def queue_command(interaction: discord.Interaction):
            await self.music_manager.queue_info(interaction)

        # Comandos de Navidrome
        from bot.navidrome_ui import NavidromeSearchView
        from bot.navidrome_client import navidrome_client

        @self.tree.command(name="search", description="Busca canciones, álbumes y artistas en Navidrome")
        @app_commands.describe(query="Lo que deseas buscar")
        async def search_command(interaction: discord.Interaction, query: str):
            await interaction.response.defer()
            results = await navidrome_client.search(query, limit=5)
            view = NavidromeSearchView(self.music_manager, results, interaction)
            embed = view.generate_embed(query)
            if not view.songs and not view.albums and not view.artists:
                await interaction.followup.send(embed=embed)
            else:
                await interaction.followup.send(embed=embed, view=view)

        @self.tree.command(name="radio", description="Inicia una radio de un artista desde Navidrome de forma interactiva")
        @app_commands.describe(query="Lo que deseas buscar para iniciar la radio")
        async def radio_command(interaction: discord.Interaction, query: str):
            await interaction.response.defer()
            results = await navidrome_client.search(query, limit=5)
            view = NavidromeSearchView(self.music_manager, results, interaction, is_radio=True)
            embed = view.generate_embed(query)
            embed.title = f"📻 Resultados para Radio: {query}"
            if not view.songs and not view.albums and not view.artists:
                await interaction.followup.send(embed=embed)
            else:
                await interaction.followup.send(embed=embed, view=view)

    async def setup_hook(self):
        # Sincronizar comandos (Global sync - puede tardar hasta 1h en propagarse si no se hace en guild específico, pero para desarrollo ok)
        # Para desarrollo rápido, se recomienda sincronizar con guild específico self.tree.sync(guild=discord.Object(id=...))
        await self.tree.sync()
        
        # Iniciar tarea de fondo para timeouts
        # Iniciar tarea de fondo para timeouts
        self.check_timeouts_task.start()
        # Iniciar tarea de festividades
        self.check_holidays_task.start()
        # Iniciar tarea de memoria temporal
        self.process_memory_queue_task.start()
        # Iniciar tarea de recuperación de sueño
        self.recovery_check_task.start()
        # Iniciar tarea de recordatorios
        self.check_reminders_task.start()
        # Iniciar tarea de desconexión de voz vacía
        self.music_manager.check_empty_voice_channels.start()

    @tasks.loop(minutes=1)
    async def check_reminders_task(self):
        """Revisa si hay acciones programadas en la memoria interna."""
        try:
            import time

            # 1. Leer memoria interna
            self_memory_text = memory.get_self_memory()
            if not self_memory_text:
                return

            # 2. Parsear acciones
            actions = scheduler.parse_scheduled_actions(self_memory_text)
            
            # 3. Filtrar las que tocan ahora
            due_actions = scheduler.check_due_actions(actions)
            if not due_actions:
                return

            now_ts = time.time()
            cache_ttl_seconds = 3600
            self.executed_actions_cache = {
                key: ts for key, ts in self.executed_actions_cache.items()
                if now_ts - ts <= cache_ttl_seconds
            }

            executed_actions = []
            
            for action in due_actions:
                action_desc = action.get("action_description")
                target_user_id = action.get("target_user_id")
                unique_key = scheduler.build_action_key(action)
                
                # Evitar duplicados recientes
                if unique_key in self.executed_actions_cache:
                    continue
                
                print(f"[SCHEDULER] Ejecutando acción: {action_desc}")
                
                # Determinar canal objetivo de forma más precisa
                channel_id = None
                if target_user_id and str(target_user_id).isdigit():
                    target_mem = memory.get_memory(str(target_user_id))
                    channel_id = target_mem.get("last_channel_id")

                if not channel_id:
                    channel_id = self.last_active_channel_id

                if not channel_id:
                    users = memory.get_all_users_data()
                    for user_data in users:
                        if user_data.get('last_channel_id'):
                            channel_id = user_data.get('last_channel_id')
                            break
                
                if channel_id:
                    channel = self.get_channel(int(channel_id))
                    if channel:
                        # Preparar contexto para la IA
                        user_context_id = "hakkurin_internal_self"
                        user_name = "Sistema"
                        ping_str = ""
                        
                        # Si hay un usuario objetivo, usar SU memoria para personalizar el mensaje
                        if target_user_id and str(target_user_id).isdigit():
                            user_context_id = str(target_user_id)
                            ping_str = f"<@{target_user_id}>"
                            # Intentar obtener nombre
                            try:
                                user_obj = await self.fetch_user(int(target_user_id))
                                if user_obj:
                                    user_name = user_obj.name
                            except:
                                user_name = "Usuario"

                        # Generar respuesta con IA usando la memoria del usuario (si existe)
                        prompt = f"""
[SISTEMA]: EJECUCIÓN DE RECORDATORIO AUTOMÁTICO.
ACCIÓN: {action_desc}
INSTRUCCIÓN: Genera el mensaje para cumplir este compromiso ahora mismo.
NOTA: Debes mencionar al usuario {ping_str} si corresponde. Usa tu memoria con él para ser personal y natural.
"""
                        # Usamos user_context_id para que cargue la memoria de ESE usuario
                        response = await brain.generate_response(prompt, user_context_id, user_name)
                        if not isinstance(response, str) or not response.strip():
                            response = f"{ping_str} recordatorio: {action_desc}".strip()
                        
                        await channel.send(response)
                        self.executed_actions_cache[unique_key] = now_ts
                        executed_actions.append(action)
                        
                        # Registrar en memoria que lo hicimos
                        memory.log_self_action(f"EJECUTÉ RECORDATORIO: {action_desc} para {user_name}")

            # Eliminar acciones ya ejecutadas del JSON para persistir dedupe entre reinicios
            if executed_actions:
                cleaned_summary = scheduler.remove_executed_actions_from_memory(self_memory_text, executed_actions)
                if cleaned_summary != self_memory_text:
                    memory.update_summary(memory.BOT_SELF_ID, cleaned_summary, processed_interactions=[])
                        
        except Exception as e:
            print(f"Error en check_reminders_task: {e}")

    @check_reminders_task.before_loop
    async def before_reminders(self):
        await self.wait_until_ready()

    async def update_bot_status(self, status_type="idle", activity_text=None):
        """Actualiza el estado y actividad del bot."""
        if not self.is_ready():
            return

        try:
            status = discord.Status.idle
            if status_type == "online":
                status = discord.Status.online
                if not activity_text: activity_text = "Conversando"
            elif status_type == "dnd":
                status = discord.Status.dnd
                if not activity_text: activity_text = "Ocupada / Error"
            else:
                status = discord.Status.idle
                if not activity_text: activity_text = "Esperando..."

            activity = discord.CustomActivity(name=activity_text) if activity_text else None
            # CustomActivity a veces no se muestra bien, mejor Game o Watching
            if activity_text:
                activity = discord.Game(name=activity_text)
            
            await self.change_presence(status=status, activity=activity)
        except Exception as e:
            print(f"Error actualizando status: {e}")

    async def on_ready(self):
        print(f'Conectado como {self.user} (ID: {self.user.id})')
        print('------')
        await self.update_bot_status("idle")

    def _load_status_messages(self):
        import json
        import os
        try:
            with open("data/status_messages.json", "r", encoding="utf-8") as f:
                self.status_messages = json.load(f)
        except:
            self.status_messages = {"tired": ["Me voy a dormir."], "recovery": ["Ya volví."]}


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
        
        # Verificar si hay sesiones activas para actualizar el estado
        any_active = False
        for session in conversation_manager.sessions.values():
            if session.is_active:
                any_active = True
                break
        
        if not any_active:
            await self.update_bot_status("idle")
        else:
            await self.update_bot_status("online")

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
        # Permitir DMs (message.guild is None) o canales permitidos
        if message.guild is not None and allowed_channels and message.channel.id not in allowed_channels:
            return

        # --- MUSIC COMMANDS HANDLING ---
        # Removido: Ahora usamos Slash Commands
        # -------------------------------
        
        # --- DEBUG COMMANDS ---
        if message.content.strip() == "!sync":
             if message.author.guild_permissions.administrator:
                 await message.channel.send("Sincronizando comandos en este servidor...")
                 try:
                     self.tree.copy_global_to(guild=message.guild)
                     await self.tree.sync(guild=message.guild)
                     await message.channel.send("✅ Comandos sincronizados. Deberían aparecer en unos instantes.")
                 except Exception as e:
                     await message.channel.send(f"❌ Error sincronizando: {e}")
             return
        # ----------------------

        # VERBOSE LOGGING FOR DMs (INPUT)
        if isinstance(message.channel, discord.DMChannel):
            print(f"\n[DM INPUT] De: {message.author.name} (ID: {message.author.id})")
            print(f"[DM INPUT] Contenido: {message.content}")
            if message.attachments:
                print(f"[DM INPUT] Adjuntos: {[a.filename for a in message.attachments]}")
            print("-" * 30)

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
        
        # DMs siempre deben procesarse
        is_dm = isinstance(message.channel, discord.DMChannel)

        should_process = is_mentioned or is_reply or was_active or is_channel_engaged or is_dm
        
        if not should_process:
            reply_prob = config.get("reply_probability", 0.01) # Reducido a 1% para evitar spam inicial
            if random.random() < reply_prob:
                should_process = True
                print(f"Trigger por probabilidad ({reply_prob}) para {message.author.display_name}")

        if should_process:
            # Activar sesión explícitamente
            session.activate()
            
            # Actualizar estado visual del bot
            asyncio.create_task(self.update_bot_status("online"))
            
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
            
            # Guardar mensaje del usuario en memoria INMEDIATAMENTE
            # Esto evita pérdida de contexto si la generación se cancela después
            asyncio.create_task(self.save_interaction(message.author.id, message.author.display_name, message.content, is_bot=False))

            # Crear nueva tarea con delay (Cooldown 3s)
            key = (message.channel.id, message.author.id)
            task = asyncio.create_task(self.process_with_debounce(message, session, key))
            self.pending_tasks[key] = task

    async def process_with_debounce(self, message, session, key):
        try:
            # Esperar 5 segundos (Cooldown para ahorrar requests de NanoGPT)
            await asyncio.sleep(5)
            
            # Verificar si alguien está escribiendo en el canal
            channel_id = message.channel.id
            if channel_id in self.typing_users and self.typing_users[channel_id]:
                # Si hay alguien escribiendo, esperamos un poco más (máximo 8s extra)
                # para dar tiempo a que terminen de escribir.
                print(f"Detectado typing en {channel_id}, esperando...")
                for _ in range(8):
                    if not self.typing_users.get(channel_id):
                        break
                    await asyncio.sleep(1)
            
            # Segunda verificación: si TODAVÍA están escribiendo, cancelar
            # Esto evita enviar requests a NanoGPT que serán desperdiciadas
            if channel_id in self.typing_users and self.typing_users[channel_id]:
                print(f"Aún hay typing en {channel_id} después de espera. Cancelando para no desperdiciar request.")
                return
            
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
        
        # OBTENER USUARIOS ACTIVOS (Contexto Dinámico 20 min)
        active_user_ids = conversation_manager.get_active_users(message.channel.id, minutes=20)
        # Añadir usuarios mencionados explícitamente en este mensaje
        for mention in message.mentions:
            if not mention.bot:
                active_user_ids.append(str(mention.id))
        
        # PROCESAR IMÁGENES (Multimodal)
        # 1. Guardar imágenes del mensaje actual en el contexto del canal
        if message.attachments:
            for attachment in message.attachments:
                if any(attachment.filename.lower().endswith(ext) for ext in ['.png', '.jpg', '.jpeg', '.webp']):
                    try:
                        print(f"Descargando imagen: {attachment.filename}")
                        img_data = await attachment.read()
                        mime = attachment.content_type or "image/jpeg"
                        # Guardar en buffer del canal
                        conversation_manager.get_channel_context(message.channel.id).add_image(img_data, mime)
                    except Exception as e:
                        print(f"Error descargando imagen: {e}")

        # 2. Recuperar imágenes recientes del contexto (incluyendo la que acabamos de guardar)
        # Esto asegura que si nos interrumpieron, la imagen anterior sigue ahí
        recent_images = conversation_manager.get_channel_context(message.channel.id).get_recent_images(seconds=60)
        
        image_data = None
        image_mime_type = None
        
        if recent_images:
            # Usar la última imagen disponible
            # (Podríamos pasar todas, pero por ahora el brain solo acepta una)
            image_data, image_mime_type = recent_images[-1]
            print(f"Usando imagen del contexto (Total en buffer: {len(recent_images)})")

        is_dm = isinstance(message.channel, discord.DMChannel)

        # 3. EXTRAER ESTADO DEL REPRODUCTOR DE MÚSICA
        current_playing = None
        if not is_dm and message.guild:
            song_title = self.music_manager.current_song.get(message.guild.id)
            if song_title:
                album = self.music_manager.current_album.get(message.guild.id, "")
                if album and album != "Unknown Album":
                    current_playing = f"{song_title} | Álbum: {album}"
                else:
                    current_playing = song_title
            
        # 4. PROCESAR ENLACES EN EL MENSAJE Y THUMBNAILS (yt-dlp básico)
        import re
        import urllib.request
        import json
        
        url_context = None
        urls = re.findall(r'(https?://\S+)', user_text)
        if urls:
            url = urls[0] # Procesar al menos el primer enlace
            
            # YouTube Fallback sin Cookies (oEmbed / Direct Thumbnail)
            is_youtube = 'youtube.com' in url or 'youtu.be' in url
            if is_youtube and not image_data:
                video_id_match = re.search(r'(?:v=|\/)([0-9A-Za-z_-]{11}).*', url)
                if video_id_match:
                    video_id = video_id_match.group(1)
                    oembed_url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
                    try:
                        def fetch_oembed():
                            req = urllib.request.Request(oembed_url, headers={'User-Agent': 'Mozilla/5.0'})
                            with urllib.request.urlopen(req, timeout=3) as response:
                                return json.loads(response.read().decode('utf-8'))
                        
                        info = await asyncio.wait_for(self.loop.run_in_executor(None, fetch_oembed), timeout=4.0)
                        if info:
                            title = info.get('title', 'Video de YouTube')
                            author = info.get('author_name', 'Autor Desconocido')
                            url_context = f"Título del video de YouTube: {title}\nCanal/Autor: {author}"
                            
                            # Obtener imagen usando URL predecible de ytimg (menos baneos que oEmbed a veces o igual de bueno)
                            thumb_url = f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg"
                            def fetch_thumb():
                                req = urllib.request.Request(thumb_url, headers={'User-Agent': 'Mozilla/5.0'})
                                with urllib.request.urlopen(req, timeout=3) as response:
                                    return response.read()
                            try:
                                image_data = await self.loop.run_in_executor(None, fetch_thumb)
                                image_mime_type = "image/jpeg"
                                print("→ Thumbnail de YouTube extraída sin cookies para visión.")
                            except Exception as e:
                                print(f"Error descargando miniatura genérica ytimg: {e}")
                    except Exception as e:
                        print(f"Error oEmbed fallback para yt: {e}")

            if not url_context: # Si no era youtube, o el oEmbed falló
                try:
                    import yt_dlp
                    # Opciones muy ligeras, extract_flat=True si no necesitamos mucha info,
                    # pero para descripciones completas en YouTube a veces se necesita download=False
                    ydl_opts = {'quiet': True, 'no_warnings': True, 'noplaylist': True}
                    
                    def extract_info():
                        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                            return ydl.extract_info(url, download=False)
                    
                    print(f"[{url}] Scrapeando metadatos del link...")
                    info = await asyncio.wait_for(self.loop.run_in_executor(None, extract_info), timeout=5.0)
                    
                    if info:
                        title = info.get('title', 'Sin título')
                        description = info.get('description', '')
                        if description:
                            description = description[:500] + '...' if len(description) > 500 else description
                        url_context = f"Título de la página/enlace: {title}\nResumen: {description}"
                        
                        # Intentar obtener thumbnail si no hay una imagen cargada por el usuario
                        if not image_data and info.get('thumbnail'):
                            def fetch_thumb():
                                req = urllib.request.Request(info['thumbnail'], headers={'User-Agent': 'Mozilla/5.0'})
                                with urllib.request.urlopen(req, timeout=3) as response:
                                    return response.read()
                            try:
                                thumb_bytes = await self.loop.run_in_executor(None, fetch_thumb)
                                image_data = thumb_bytes
                                image_mime_type = "image/jpeg"
                                print("→ Thumbnail del enlace extraída como visión multimodal para el bot.")
                            except Exception as thumb_e:
                                print(f"Error descargando miniatura: {thumb_e}")
                                
                except Exception as e:
                    # Si falla (seguramente porque no es un sitio soportado por yt-dlp) o por timeout
                    try:
                        def fetch_html():
                            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'})
                            with urllib.request.urlopen(req, timeout=3) as response:
                                return response.read().decode('utf-8', errors='ignore')
                        
                        html = await asyncio.wait_for(self.loop.run_in_executor(None, fetch_html), timeout=3.0)
                        title_match = re.search(r'<title>(.*?)</title>', html, re.IGNORECASE | re.DOTALL)
                        desc_match = re.search(r'<meta[^>]*name=["\']description["\'][^>]*content=["\'](.*?)["\']', html, re.IGNORECASE | re.DOTALL)
                        
                        page_title = title_match.group(1).strip() if title_match else 'Sin título'
                        page_desc = desc_match.group(1).strip() if desc_match else 'Sin descripción extraíble'
                        if title_match or desc_match:
                            url_context = f"Título web del enlace: {page_title}\nMetadescripción: {page_desc}"
                    except Exception as ex2:
                        print(f"Fallo fallback al parsear enlace HTML (posible bot protection): {ex2}")
                        url_context = None

        # Análisis de IA
        
        analysis = await brain.analyze_interaction(
            user_text=user_text,
            user_id=user_id,
            user_name=user_name,
            context_messages=channel_history, # Pasamos el historial global
            is_session_active=session.is_active,
            image_data=image_data,
            image_mime_type=image_mime_type,
            active_user_ids=active_user_ids,
            is_dm=is_dm,
            current_playing=current_playing,
            url_context=url_context
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

            pending_dms = []
            
            for i, msg_text in enumerate(response_content):
                if not msg_text: continue
                
                # --- MANEJO DE DM INVISIBLE ---
                # Extraer cualquier etiqueta [MD:id]mensaje[/MD] o sus variaciones mal cerradas
                dm_matches = re.finditer(r'\[MD:(\d+)\](.*?)(?:\[/MD\]|/MD\]|\[/MD|$)', msg_text, re.IGNORECASE | re.DOTALL)
                for dm_match in dm_matches:
                    target_uid = dm_match.group(1)
                    dm_msg = dm_match.group(2).strip()
                    if target_uid and dm_msg:
                        pending_dms.append((target_uid, dm_msg))
                
                # Quitar las etiquetas del mensaje para el canal público de forma invisible
                msg_text = re.sub(r'\[MD:\d+\].*?(?:\[/MD\]|/MD\]|\[/MD|$)', '', msg_text, flags=re.IGNORECASE | re.DOTALL).strip()
                
                # Si resultó que el mensaje de respuesta de la IA ERA SÓLO el DM para esa persona
                if not msg_text:
                    continue
                
                # Añadir pings al primer mensaje público
                if i == 0 and ping_text:
                    msg_text = ping_text + msg_text

                # Calcular tiempo de escritura: ~0.05s por caracter, mínimo 0.5s, máximo 4s
                typing_time = min(max(len(msg_text) * 0.08, 0.5), 4.0)
                
                try:
                    async with message.channel.typing():
                        await asyncio.sleep(typing_time)
                        # Usar referencia solo en el primer mensaje si existe
                        if i == 0 and reference:
                            try:
                                await message.channel.send(msg_text, reference=reference)
                            except discord.NotFound:
                                 await message.channel.send(msg_text) # Fallback si el mensaje se borró
                        else:
                            await message.channel.send(msg_text)
                except discord.errors.DiscordServerError as dse:
                    print(f"Error 5xx de Discord enviando respuesta al canal: {dse}. Ignorando.")
                except Exception as e:
                     print(f"Error inesperado enviando respuesta: {e}")

                # VERBOSE LOGGING FOR DMs (OUTPUT)
                if isinstance(message.channel, discord.DMChannel):
                    print(f"\n[DM OUTPUT] Para: {user_name} (ID: {user_id})")
                    print(f"[DM OUTPUT] Contenido: {msg_text}")
                    print("-" * 30)
                
                full_response_text += msg_text + " "
                # Pequeña pausa entre mensajes
                await asyncio.sleep(random.uniform(0.2, 0.5))
                
            # --- PROCESAR MENSAJES DIRECTOS CON RETRASO ---
            if pending_dms:
                async def send_delayed_dms(dms_to_send):
                    await asyncio.sleep(3.0) # Esperar 3 segundos después de responder en el canal
                    for t_uid, t_msg in dms_to_send:
                        await self.send_stealth_dm(message, t_uid, t_msg)
                asyncio.create_task(send_delayed_dms(pending_dms))
            
            # Añadir respuesta completa al contexto GLOBAL
            channel_ctx = conversation_manager.get_channel_context(message.channel.id)
            channel_ctx.add_message(config.get('bot_name'), str(self.user.id), full_response_text.strip())
            channel_ctx.update_bot_activity() # Marcar que el bot está activo en este canal

            # --- SELF MEMORY LOGGING ---
            # Registrar lo que el bot acaba de decir en su propia memoria
            should_summarize_self = memory.log_self_action(full_response_text.strip())
            
            if should_summarize_self:
                print("Trigger de resumen de AUTO-MEMORIA activado.")
                asyncio.create_task(self.perform_memory_summarization(memory.BOT_SELF_ID))
            
            # Guardar último canal conocido para festividades
            memory.update_last_channel(user_id, message.channel.id)

            # Actualizar memoria con la RESPUESTA DEL BOT
            asyncio.create_task(self.save_interaction(user_id, user_name, full_response_text.strip(), is_bot=True))
        
        elif intent == "ignore":
            print(f"Ignorando mensaje de {user_name} (Intención: ignore)")
            pass
            
        elif intent == "error":
            print(f"Error crítico detectado en análisis de IA. Activando modo sueño de emergencia.")
            await self.update_bot_status("dnd", "Error Crítico")
            await self.enter_sleep_mode(message.channel)
            
    async def send_stealth_dm(self, message_ctx, target_uid, dm_msg):
        """Intenta enviar un MD de manera silenciosa detectado en un bloque [MD][/MD]"""
        try:
            target_obj = None
            if message_ctx.guild:
                target_obj = message_ctx.guild.get_member(int(target_uid))
                if not target_obj:
                    try:
                        target_obj = await message_ctx.guild.fetch_member(int(target_uid))
                    except Exception:
                        pass
            
            # Si no es miembro del server actual o estamos en MD, usar usuario global
            if not target_obj:
                target_obj = await self.fetch_user(int(target_uid))
                
            if target_obj:
                await target_obj.send(dm_msg)
                print(f"[MD OCULTO] Enviado exitosamente a {target_uid}: {dm_msg}")
        except discord.Forbidden as f:
            print(f"[MD OCULTO] 403 Forbidden enviando a {target_uid}. El usuario cerró sus DMs o no comparten server (Error: {f})")
        except Exception as e:
            print(f"[MD OCULTO] Error interno enviando a {target_uid}: {e}")

    async def save_interaction(self, user_id, user_name, content, is_bot=False):
        """Guarda una interacción en la memoria a largo plazo."""
        try:
            # Actualizar nombre si no existe y es usuario
            if not is_bot:
                current_mem = memory.get_memory(user_id)
                if not current_mem["profile"]["name"]:
                    current_mem["profile"]["name"] = user_name
                    memory.save_memory(user_id, current_mem)

            # Formatear texto
            if is_bot:
                interaction_text = f"Hakkurin: {content}"
            else:
                interaction_text = f"Usuario: {content}"

            # Añadir interacción a la COLA TEMPORAL (espera 30 min)
            memory.add_to_queue(user_id, interaction_text)
            print(f"Interacción de {user_id} encolada en memoria temporal.")
                
        except Exception as e:
            print(f"Error guardando interacción: {e}")

    async def enter_sleep_mode(self, channel):
        """Activa el modo sueño por 2 horas y envía mensaje de despedida."""
        import time
        self.is_sleeping = True
        # 2 horas = 7200 segundos
        self.sleep_until = time.time() + 7200
        
        # Enviar mensaje de cansancio
        msg = random.choice(self.status_messages.get("tired", ["Me voy a dormir."]))
        try:
            await channel.send(msg)
        except:
            pass
        print(f"Modo Sueño activado hasta {self.sleep_until}")

    @tasks.loop(seconds=60)
    async def recovery_check_task(self):
        """Revisa si ya pasó el tiempo de sueño y prueba la API."""
        import time
        if not self.is_sleeping: return
        
        if time.time() > self.sleep_until:
            print("Tiempo de sueño cumplido. Probando recuperación de API...")
            
            # Probar API
            is_healthy = await brain.test_api_connection()
            
            if is_healthy:
                print("API recuperada. Despertando...")
                self.is_sleeping = False
                self.sleep_until = 0
                
                # Enviar mensaje de recuperación si tenemos canal
                if self.last_active_channel_id:
                    try:
                        channel = self.get_channel(self.last_active_channel_id)
                        if channel:
                            msg = random.choice(self.status_messages.get("recovery", ["Ya volví."]))
                            await channel.send(msg)
                    except Exception as e:
                        print(f"No se pudo enviar mensaje de recuperación: {e}")
            else:
                print("API sigue fallando. Durmiendo 2 horas más (silenciosamente).")
                self.sleep_until = time.time() + 7200

    async def perform_memory_summarization(self, user_id, model_name=None):
        try:
            current_summary, buffer = memory.get_buffer_and_summary(user_id)
            if not buffer: return

            new_summary = await brain.generate_summary(current_summary, buffer, user_id, model_name=model_name)
            
            if new_summary:
                memory.update_summary(user_id, new_summary, processed_interactions=buffer)
                print(f"Resumen de memoria actualizado para {user_id}")
        except Exception as e:
            print(f"Error en proceso de resumen: {e}")

    async def force_shutdown_and_summarize(self):
        """Fuerza el resumen de todos los usuarios pendientes y cierra el bot."""
        print("Iniciando apagado controlado con resumen forzado...")
        pending_users = memory.get_users_with_pending_buffer()
        
        if pending_users:
            print(f"Resumiendo memorias para {len(pending_users)} usuarios (Forzando Gemma)...")
            # Usar Gemma-3-27b-it para el resumen final de alta calidad
            tasks = [self.perform_memory_summarization(uid, model_name="gemma-3-27b-it") for uid in pending_users]
            await asyncio.gather(*tasks)
            print("Todos los resúmenes completados.")
        
        print("Cerrando conexión con Discord...")
        await self.close()

    @tasks.loop(seconds=60)
    async def process_memory_queue_task(self):
        """Procesa la cola de memoria temporal cada minuto."""
        try:
            # 1. Mover items viejos (>5min) a permanente
            # Esto retorna usuarios que cumplieron criterio en add_interaction (20 msgs o >30 min desde último resumen)
            users_to_summarize = set(await asyncio.to_thread(memory.process_queue))
            
            # 2. Revisar usuarios que NO han hablado recientemente pero tienen buffer viejo (>6h)
            stale_users = await asyncio.to_thread(memory.check_stale_buffers)
            users_to_summarize.update(stale_users)
            
            if users_to_summarize:
                print(f"Procesando resumen para {len(users_to_summarize)} usuarios (Batch/Stale)...")
                for uid in users_to_summarize:
                    asyncio.create_task(self.perform_memory_summarization(uid))
        except Exception as e:
            print(f"Error en process_memory_queue_task: {e}")

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
