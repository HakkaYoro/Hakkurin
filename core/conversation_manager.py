import time
import asyncio
from core.ai_handler import brain
from core.memory_manager import memory

# Tiempo de espera antes de considerar la sesión inactiva (5 minutos)
SESSION_TIMEOUT = 5 * 60 

class Session:
    def __init__(self, channel_id, user_id):
        self.channel_id = channel_id
        self.user_id = user_id
        self.last_interaction = time.time()
        self.is_active = False # Por defecto inactiva hasta que se decida responder
        self.ignored_count = 0
        self.context_messages = [] # Lista de dicts: {'timestamp': float, 'content': str}

    def update_interaction(self):
        self.last_interaction = time.time()
        # No activamos automáticamente, solo actualizamos tiempo
        
    def activate(self):
        self.is_active = True
        self.last_interaction = time.time()

    def add_context(self, message):
        now = time.time()
        self.context_messages.append({'timestamp': now, 'content': message})
        self._cleanup_context(now)

    def _cleanup_context(self, now):
        # Mantener solo mensajes de la última 1 hora (3600 segundos)
        cutoff = now - 3600
        self.context_messages = [msg for msg in self.context_messages if msg['timestamp'] > cutoff]

    def get_context_text(self):
        # Retorna solo el texto para la IA
        return [msg['content'] for msg in self.context_messages]

class ChannelContext:
    def __init__(self, channel_id):
        self.channel_id = channel_id
        self.messages = [] # Lista de dicts: {'timestamp': float, 'content': str, 'author': str}
        self.last_bot_activity = 0 # Timestamp de la última vez que el bot habló aquí

    def add_message(self, author_name, author_id, content):
        now = time.time()
        self.messages.append({'timestamp': now, 'content': content, 'author': author_name, 'author_id': author_id})
        self._cleanup(now)

    def update_bot_activity(self):
        self.last_bot_activity = time.time()

    def is_bot_engaged(self, timeout=60):
        """Retorna True si el bot ha estado activo recientemente en este canal."""
        return (time.time() - self.last_bot_activity) < timeout

    def _cleanup(self, now):
        # Mantener últimos 50 mensajes o 1 hora
        cutoff = now - 3600
        self.messages = [msg for msg in self.messages if msg['timestamp'] > cutoff][-50:]

    def get_formatted_history(self):
        # Formato: Nombre (ID: 12345): Mensaje
        return [f"{msg['author']} (ID: {msg['author_id']}): {msg['content']}" for msg in self.messages]

class ConversationManager:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(ConversationManager, cls).__new__(cls)
            cls._instance.sessions = {} # Key: (channel_id, user_id) -> Session
            cls._instance.channels = {} # Key: channel_id -> ChannelContext
            cls._instance._start_cleanup_task()
        return cls._instance

    def _start_cleanup_task(self):
        pass 

    def get_session(self, channel_id, user_id):
        key = (channel_id, user_id)
        return self.sessions.get(key)

    def get_channel_context(self, channel_id):
        if channel_id not in self.channels:
            self.channels[channel_id] = ChannelContext(channel_id)
        return self.channels[channel_id]

    def create_or_update_session(self, channel_id, user_id, user_name=None, message_content=None):
        # Actualizar sesión de usuario
        key = (channel_id, user_id)
        if key not in self.sessions:
            self.sessions[key] = Session(channel_id, user_id)
            print(f"Nueva sesión creada para {user_id} en {channel_id}")
        else:
            self.sessions[key].update_interaction()
        
        # Actualizar contexto del canal si hay mensaje
        if user_name and message_content:
            self.get_channel_context(channel_id).add_message(user_name, user_id, message_content)
            # También añadimos al contexto personal por si acaso, aunque usaremos el global
            self.sessions[key].add_context(f"{user_name}: {message_content}")

        return self.sessions[key]

    def get_active_users(self, channel_id, minutes=20):
        """
        Devuelve una lista de IDs de usuarios que han estado activos en el canal en los últimos X minutos.
        """
        active_ids = set()
        channel_ctx = self.get_channel_context(channel_id)
        
        now = time.time()
        cutoff = now - (minutes * 60)
        
        # Iterar mensajes del canal (que ya están limpios a 1h, así que es rápido)
        for msg in channel_ctx.messages:
            if msg['timestamp'] > cutoff:
                active_ids.add(str(msg['author_id']))
                
        return list(active_ids)

    def end_session(self, channel_id, user_id):
        key = (channel_id, user_id)
        if key in self.sessions:
            del self.sessions[key]
            print(f"Sesión finalizada para {user_id} en {channel_id}")

    async def check_timeouts(self, bot_send_message_callback):
        """
        Revisa sesiones expiradas y decide si enviar un mensaje de despedida/queja.
        Args:
            bot_send_message_callback: Función async (channel_id, text) para enviar mensajes.
        """
        import random
        now = time.time()
        keys_to_remove = []

        for key, session in self.sessions.items():
            if not session.is_active:
                continue

            if now - session.last_interaction > SESSION_TIMEOUT:
                print(f"Sesión expirada para {key}")
                
                # Probabilidad de 1/8 (12.5%) de reaccionar
                if random.random() > 0.125:
                    print(f"  -> Timeout silencioso (Probabilidad 7/8).")
                else:
                    # Oportunidad para que la IA se queje o se despida
                    # Recuperamos memoria para contexto
                    mem_summary = memory.get_memory_summary(session.user_id)
                    channel_history = self.get_channel_context(session.channel_id).get_formatted_history()
                    
                    # Pedimos a la IA una reacción de "cierre por timeout"
                    fake_msg = "[SISTEMA]: El usuario ha dejado de responder por 5 minutos. ¿Quieres decir algo antes de irte? (Si no, responde con intent: ignore) (Máximo 2 mensajes cortos)"
                    
                    try:
                        analysis = await brain.analyze_interaction(
                            user_text=fake_msg,
                            user_id=session.user_id,
                            user_name="System",
                            context_messages=channel_history,
                            is_session_active=True
                        )
                        
                        response_content = analysis.get("response_content", [])
                        # Normalizar a lista si es string
                        if isinstance(response_content, str):
                             response_content = [response_content]
                        
                        if analysis.get("intent") in ["complain", "reply", "new_topic"] and response_content:
                            # LIMITAR SPAM: Máximo 2 mensajes
                            for i, msg_text in enumerate(response_content):
                                if i >= 2: break 
                                if isinstance(msg_text, str):
                                    await bot_send_message_callback(session.channel_id, msg_text)
                    except Exception as e:
                        print(f"Error en timeout check: {e}")

                keys_to_remove.append(key)

        for key in keys_to_remove:
            self.end_session(key[0], key[1])

# Instancia global
conversation_manager = ConversationManager()
