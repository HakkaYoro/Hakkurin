import os
import json
import time
from cryptography.fernet import Fernet

MEMORY_DIR = "data/memory/users"
KEY_FILE = "data/memory/secret.key"
SUMMARY_DIR = "data/memory/summaries"

class MemoryManager:
    QUEUE_FILE = "data/memory/queue.json"
    QUEUE_TO_PERMANENT_DELAY_SECONDS = 300
    STALE_BUFFER_SECONDS = 1800
    SUMMARY_TRIGGER_SECONDS = 1800
    SUMMARY_TRIGGER_INTERACTIONS = 20
    QUEUE_DUPLICATE_WINDOW_SECONDS = 10

    def __init__(self):
        self._ensure_directories()
        self.key = self._load_or_create_key()
        self.cipher = Fernet(self.key)

    def _ensure_directories(self):
        os.makedirs(MEMORY_DIR, exist_ok=True)
        os.makedirs(os.path.dirname(KEY_FILE), exist_ok=True)
        os.makedirs(SUMMARY_DIR, exist_ok=True)

    def _load_or_create_key(self):
        if os.path.exists(KEY_FILE):
            with open(KEY_FILE, "rb") as f:
                return f.read()
        else:
            key = Fernet.generate_key()
            with open(KEY_FILE, "wb") as f:
                f.write(key)
            return key

    def _atomic_write_bytes(self, path, data_bytes):
        temp_path = f"{path}.tmp"
        with open(temp_path, "wb") as f:
            f.write(data_bytes)
        os.replace(temp_path, path)

    def _atomic_write_text(self, path, content):
        temp_path = f"{path}.tmp"
        with open(temp_path, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(temp_path, path)

    def _get_file_path(self, user_id):
        return os.path.join(MEMORY_DIR, f"{self._sanitize_user_id(user_id)}.enc")

    def _sanitize_user_id(self, user_id):
        return str(user_id).strip()

    def _normalize_memory_schema(self, mem):
        """Ajusta memorias antiguas o parciales sin romper compatibilidad."""
        if not isinstance(mem, dict):
            mem = {}

        normalized = self._create_empty_memory()
        normalized.update(mem)

        profile = normalized.get("profile")
        if not isinstance(profile, dict):
            profile = {}
        profile_defaults = self._create_empty_memory()["profile"]
        safe_profile = dict(profile_defaults)
        for key in profile_defaults:
            value = profile.get(key, profile_defaults[key])
            if key in ["personality_traits", "likes", "dislikes"]:
                if isinstance(value, list):
                    safe_profile[key] = [str(v) for v in value if isinstance(v, (str, int, float))]
                else:
                    safe_profile[key] = []
            else:
                safe_profile[key] = str(value) if value is not None else profile_defaults[key]
        normalized["profile"] = safe_profile

        if not isinstance(normalized.get("interaction_count"), int):
            normalized["interaction_count"] = 0

        if not isinstance(normalized.get("last_topics"), list):
            normalized["last_topics"] = []

        if not isinstance(normalized.get("notes"), str):
            normalized["notes"] = "Usuario nuevo."

        if not isinstance(normalized.get("summary"), str):
            normalized["summary"] = ""

        if not isinstance(normalized.get("history_buffer"), list):
            normalized["history_buffer"] = []
        else:
            normalized["history_buffer"] = [
                str(item)
                for item in normalized["history_buffer"]
                if isinstance(item, (str, int, float))
            ]

        last_summary_time = normalized.get("last_summary_time", 0)
        try:
            normalized["last_summary_time"] = float(last_summary_time)
        except (TypeError, ValueError):
            normalized["last_summary_time"] = 0

        last_channel_id = normalized.get("last_channel_id")
        if last_channel_id is not None:
            try:
                normalized["last_channel_id"] = int(last_channel_id)
            except (TypeError, ValueError):
                normalized["last_channel_id"] = None
        else:
            normalized["last_channel_id"] = None

        return normalized

    def get_memory(self, user_id):
        """Recupera la memoria desencriptada de un usuario."""
        file_path = self._get_file_path(user_id)
        if not os.path.exists(file_path):
            return self._create_empty_memory()
        
        try:
            with open(file_path, "rb") as f:
                encrypted_data = f.read()
            decrypted_data = self.cipher.decrypt(encrypted_data)
            raw_data = json.loads(decrypted_data.decode('utf-8'))
            return self._normalize_memory_schema(raw_data)
        except Exception as e:
            print(f"Error leyendo memoria de {user_id}: {e}")
            return self._create_empty_memory()

    def save_memory(self, user_id, memory_data):
        """Encripta y guarda la memoria de un usuario."""
        file_path = self._get_file_path(user_id)
        try:
            normalized = self._normalize_memory_schema(memory_data)
            json_data = json.dumps(normalized, ensure_ascii=False)
            encrypted_data = self.cipher.encrypt(json_data.encode('utf-8'))
            self._atomic_write_bytes(file_path, encrypted_data)
        except Exception as e:
            print(f"Error guardando memoria de {user_id}: {e}")

    def _create_empty_memory(self):
        return {
            "profile": {
                "name": "",
                "personality_traits": [],
                "likes": [],
                "dislikes": [],
                "speaking_style": ""
            },
            "interaction_count": 0,
            "last_topics": [],
            "notes": "Usuario nuevo.",
            "summary": "",
            "history_buffer": [],
            "last_summary_time": 0,
            "last_channel_id": None
        }

    def add_interaction(self, user_id, interaction_text):
        """Añade una interacción al buffer y devuelve True si es hora de resumir (cada 3h)."""
        if interaction_text is None:
            return False
        interaction_text = str(interaction_text).strip()
        if not interaction_text:
            return False

        mem = self.get_memory(user_id)
        mem["history_buffer"].append(interaction_text)
        mem["interaction_count"] += 1

        now = time.time()
        time_since_last = now - mem.get("last_summary_time", 0)
        should_summarize = (
            len(mem["history_buffer"]) >= self.SUMMARY_TRIGGER_INTERACTIONS
            or (len(mem["history_buffer"]) > 0 and time_since_last > self.SUMMARY_TRIGGER_SECONDS)
        )

        self.save_memory(user_id, mem)
        return should_summarize

    def check_stale_buffers(self):
        """Revisa todos los usuarios y devuelve los que tienen mensajes pendientes por > 30 min."""
        users = []
        if not os.path.exists(MEMORY_DIR):
            return users

        now = time.time()

        for filename in os.listdir(MEMORY_DIR):
            if filename.endswith(".enc"):
                user_id = filename.replace(".enc", "")
                mem = self.get_memory(user_id)

                buffer = mem.get("history_buffer", [])
                last_sum = mem.get("last_summary_time", 0)

                if buffer and (now - last_sum > self.STALE_BUFFER_SECONDS):
                    users.append(user_id)
        return users

    # --- SELF MEMORY ---
    BOT_SELF_ID = "hakkurin_internal_self"

    def get_self_memory(self):
        """Devuelve el resumen de la memoria interna del bot."""
        mem = self.get_memory(self.BOT_SELF_ID)
        return mem.get("summary", "Sin memoria interna previa.")

    def log_self_action(self, action_text):
        """Registra una acción propia del bot en su memoria."""
        # Usamos el mismo mecanismo que para usuarios, pero con el ID especial
        # Esto disparará resúmenes periódicos de "qué he hecho hoy"
        return self.add_interaction(self.BOT_SELF_ID, f"[YO DIJE/HICE]: {action_text}")

    def get_buffer_and_summary(self, user_id):
        mem = self.get_memory(user_id)
        return mem.get("summary", ""), list(mem.get("history_buffer", []))

    def update_summary(self, user_id, new_summary, processed_interactions=None):
        """
        Actualiza el resumen y limpia solo las interacciones realmente procesadas.
        Esto evita perder mensajes nuevos que entren mientras la IA resumía.
        """
        mem = self.get_memory(user_id)
        mem["summary"] = str(new_summary) if new_summary is not None else ""

        current_buffer = list(mem.get("history_buffer", []))
        if processed_interactions is None:
            mem["history_buffer"] = []
        else:
            processed = [str(item) for item in processed_interactions]
            prefix_len = len(processed)
            if prefix_len > 0 and current_buffer[:prefix_len] == processed:
                mem["history_buffer"] = current_buffer[prefix_len:]
            elif prefix_len == 0:
                mem["history_buffer"] = current_buffer
            else:
                # Si no coincide el prefijo, conservamos el buffer completo para no perder datos.
                mem["history_buffer"] = current_buffer

        mem["last_summary_time"] = time.time()
        self.save_memory(user_id, mem)

        # Guardar copia plana del resumen
        self._save_summary_plaintext(user_id, mem["summary"])

    def _save_summary_plaintext(self, user_id, summary_text):
        """Guarda el resumen en un archivo de texto plano visible."""
        file_path = os.path.join(SUMMARY_DIR, f"{user_id}.txt")
        try:
            self._atomic_write_text(file_path, str(summary_text) if summary_text is not None else "")
        except Exception as e:
            print(f"Error guardando resumen plano de {user_id}: {e}")

    def get_users_with_pending_buffer(self):
        """Devuelve una lista de user_ids que tienen mensajes en el buffer sin resumir."""
        users = []
        if not os.path.exists(MEMORY_DIR):
            return users

        for filename in os.listdir(MEMORY_DIR):
            if filename.endswith(".enc"):
                user_id = filename.replace(".enc", "")
                _, buffer = self.get_buffer_and_summary(user_id)
                if buffer:
                    users.append(user_id)
        return users

    def get_memory_summary(self, user_id):
        """Devuelve un string resumen para inyectar en el prompt."""
        mem = self.get_memory(user_id)
        profile = mem.get("profile", {})
        notes = mem.get("notes", "")
        summary = mem.get("summary", "")

        # Construir el texto que verá la IA
        final_text = f"Notas Básicas: {notes}\n"
        if summary:
            final_text += f"RESUMEN DETALLADO A LARGO PLAZO:\n{summary}\n"

        # Inyectar memoria temporal (Cola)
        queued_msgs = self.get_queued_interactions(user_id)
        if queued_msgs:
            final_text += f"MEMORIA RECIENTE (No procesada):\n" + "\n".join(queued_msgs) + "\n"

        if profile.get("name"):
            final_text += f"Nombre: {profile['name']}\n"
        if profile.get("likes"):
            final_text += f"Gustos: {', '.join(profile['likes'])}\n"

        return final_text

    def update_last_channel(self, user_id, channel_id):
        """Actualiza el último canal donde se vio al usuario."""
        mem = self.get_memory(user_id)
        try:
            mem["last_channel_id"] = int(channel_id)
        except (TypeError, ValueError):
            mem["last_channel_id"] = None
        self.save_memory(user_id, mem)

    def get_all_users_data(self):
        """
        Devuelve una lista de dicts con datos básicos de todos los usuarios para eventos globales.
        Retorna: [{'user_id': str, 'last_channel_id': int, 'summary': str}, ...]
        """
        users_data = []
        if not os.path.exists(MEMORY_DIR):
            return users_data

        for filename in os.listdir(MEMORY_DIR):
            if filename.endswith(".enc"):
                user_id = filename.replace(".enc", "")
                mem = self.get_memory(user_id)
                users_data.append({
                    'user_id': user_id,
                    'last_channel_id': mem.get('last_channel_id'),
                    'summary': self.get_memory_summary(user_id)
                })
        return users_data

    def _normalize_queue_item(self, item):
        if not isinstance(item, dict):
            return None
        user_id = item.get("user_id")
        text = item.get("text")
        timestamp = item.get("timestamp")

        if user_id is None or text is None:
            return None

        user_id = str(user_id).strip()
        text = str(text).strip()
        if not user_id or not text:
            return None

        try:
            timestamp = float(timestamp)
        except (TypeError, ValueError):
            timestamp = time.time()

        return {
            "user_id": user_id,
            "text": text,
            "timestamp": timestamp
        }

    def _load_queue(self):
        if os.path.exists(self.QUEUE_FILE):
            try:
                with open(self.QUEUE_FILE, "r", encoding="utf-8") as f:
                    raw_queue = json.load(f)
                if not isinstance(raw_queue, list):
                    return []
                normalized = []
                for item in raw_queue:
                    safe_item = self._normalize_queue_item(item)
                    if safe_item:
                        normalized.append(safe_item)
                return normalized
            except Exception:
                return []
        return []

    def _save_queue(self, queue_data):
        os.makedirs(os.path.dirname(self.QUEUE_FILE), exist_ok=True)
        safe_queue = []
        for item in queue_data:
            safe_item = self._normalize_queue_item(item)
            if safe_item:
                safe_queue.append(safe_item)

        temp_path = f"{self.QUEUE_FILE}.tmp"
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(safe_queue, f, ensure_ascii=False, indent=2)
        os.replace(temp_path, self.QUEUE_FILE)

    def add_to_queue(self, user_id, text):
        """Añade una interacción a la cola temporal."""
        if text is None:
            return

        text = str(text).strip()
        user_id = self._sanitize_user_id(user_id)
        if not text or not user_id:
            return

        queue = self._load_queue()
        now = time.time()

        # Dedupe rápida: evita duplicados inmediatos por reintentos/cancelaciones.
        for item in reversed(queue[-50:]):
            if item.get("user_id") == user_id and item.get("text") == text:
                if now - item.get("timestamp", 0) <= self.QUEUE_DUPLICATE_WINDOW_SECONDS:
                    return

        queue.append({"user_id": user_id, "text": text, "timestamp": now})
        self._save_queue(queue)

    def get_queued_interactions(self, user_id):
        """Recupera interacciones recientes de la cola para este usuario."""
        queue = self._load_queue()
        user_id = self._sanitize_user_id(user_id)
        # Filtrar mensajes de este usuario
        return [item["text"] for item in queue if item.get("user_id") == user_id]

    def process_queue(self):
        """
        Mueve items de la cola temporal a la permanente si tienen > 30 min.
        Retorna lista de user_ids que necesitan resumen.
        """
        queue = self._load_queue()
        if not queue:
            return []

        now = time.time()
        new_queue = []
        users_to_summarize = set()

        for item in queue:
            if now - item["timestamp"] > self.QUEUE_TO_PERMANENT_DELAY_SECONDS:
                # Mover a memoria permanente
                user_id = item["user_id"]
                should_sum = self.add_interaction(user_id, item["text"])
                if should_sum:
                    users_to_summarize.add(user_id)
            else:
                # Mantener en cola
                new_queue.append(item)
        
        if len(new_queue) != len(queue):
            self._save_queue(new_queue)

        return list(users_to_summarize)

# Instancia global
memory = MemoryManager()
