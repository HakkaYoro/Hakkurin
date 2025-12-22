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
        self.is_active = True
        self.ignored_count = 0
        self.context_messages = [] # Lista de dicts: {'timestamp': float, 'content': str}

    def update_interaction(self):
        self.last_interaction = time.time()
        self.ignored_count = 0
        self.is_active = True

    def add_context(self, message):
        now = time.time()
        self.context_messages.append({'timestamp': now, 'content': message})
        self._cleanup_context(now)

    def _cleanup_context(self, now):
        # Mantener solo mensajes de las últimas 24 horas (86400 segundos)
        cutoff = now - 86400
        self.context_messages = [msg for msg in self.context_messages if msg['timestamp'] > cutoff]

    def get_context_text(self):
        # Retorna solo el texto para la IA
        return [msg['content'] for msg in self.context_messages]

class ConversationManager:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(ConversationManager, cls).__new__(cls)
            cls._instance.sessions = {} # Key: (channel_id, user_id) -> Session
            cls._instance._start_cleanup_task()
        return cls._instance

    def _start_cleanup_task(self):
        # Tarea de fondo para chequear timeouts (se iniciará al importar o llamar explícitamente)
        # Nota: En un entorno real, esto debería manejarse con cuidado en el event loop de Discord
        pass 

    def get_session(self, channel_id, user_id):
        key = (channel_id, user_id)
        return self.sessions.get(key)

    def create_or_update_session(self, channel_id, user_id):
        key = (channel_id, user_id)
        if key not in self.sessions:
            self.sessions[key] = Session(channel_id, user_id)
            print(f"Nueva sesión creada para {user_id} en {channel_id}")
        else:
            self.sessions[key].update_interaction()
        return self.sessions[key]

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
        now = time.time()
        keys_to_remove = []

        for key, session in self.sessions.items():
            if not session.is_active:
                continue

            if now - session.last_interaction > SESSION_TIMEOUT:
                print(f"Sesión expirada para {key}")
                
                # Oportunidad para que la IA se queje o se despida
                # Recuperamos memoria para contexto
                mem_summary = memory.get_memory_summary(session.user_id)
                
                # Pedimos a la IA una reacción de "cierre por timeout"
                # Simulamos un mensaje de sistema interno
                fake_msg = "[SISTEMA]: El usuario ha dejado de responder por 5 minutos. ¿Quieres decir algo antes de irte? (Si no, responde con intent: ignore)"
                
                try:
                    analysis = await brain.analyze_interaction(fake_msg, mem_summary, session.get_context_text(), is_session_active=True)
                    
                    if analysis.get("intent") in ["complain", "reply", "new_topic"] and analysis.get("response_content"):
                        await bot_send_message_callback(session.channel_id, analysis["response_content"])
                except Exception as e:
                    print(f"Error en timeout check: {e}")

                keys_to_remove.append(key)

        for key in keys_to_remove:
            self.end_session(key[0], key[1])

# Instancia global
conversation_manager = ConversationManager()
