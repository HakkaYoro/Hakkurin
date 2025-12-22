import os
import json
from cryptography.fernet import Fernet

MEMORY_DIR = "data/memory/users"
KEY_FILE = "data/memory/secret.key"

class MemoryManager:
    def __init__(self):
        self._ensure_directories()
        self.key = self._load_or_create_key()
        self.cipher = Fernet(self.key)

    def _ensure_directories(self):
        if not os.path.exists(MEMORY_DIR):
            os.makedirs(MEMORY_DIR)

    def _load_or_create_key(self):
        if os.path.exists(KEY_FILE):
            with open(KEY_FILE, "rb") as f:
                return f.read()
        else:
            key = Fernet.generate_key()
            # Asegurar que el directorio padre existe
            os.makedirs(os.path.dirname(KEY_FILE), exist_ok=True)
            with open(KEY_FILE, "wb") as f:
                f.write(key)
            return key

    def _get_file_path(self, user_id):
        return os.path.join(MEMORY_DIR, f"{user_id}.enc")

    def get_memory(self, user_id):
        """Recupera la memoria desencriptada de un usuario."""
        file_path = self._get_file_path(user_id)
        if not os.path.exists(file_path):
            return self._create_empty_memory()
        
        try:
            with open(file_path, "rb") as f:
                encrypted_data = f.read()
            decrypted_data = self.cipher.decrypt(encrypted_data)
            return json.loads(decrypted_data.decode('utf-8'))
        except Exception as e:
            print(f"Error leyendo memoria de {user_id}: {e}")
            return self._create_empty_memory()

    def save_memory(self, user_id, memory_data):
        """Encripta y guarda la memoria de un usuario."""
        file_path = self._get_file_path(user_id)
        try:
            json_data = json.dumps(memory_data, ensure_ascii=False)
            encrypted_data = self.cipher.encrypt(json_data.encode('utf-8'))
            with open(file_path, "wb") as f:
                f.write(encrypted_data)
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
            "summary": "", # Resumen a largo plazo generado por IA
            "history_buffer": [] # Buffer de mensajes recientes para el próximo resumen
        }

    def add_interaction(self, user_id, interaction_text):
        """Añade una interacción al buffer y devuelve True si es hora de resumir (cada 3h)."""
        import time
        mem = self.get_memory(user_id)
        
        # Asegurar que existan los campos nuevos en memorias viejas
        if "history_buffer" not in mem: mem["history_buffer"] = []
        if "summary" not in mem: mem["summary"] = ""
        if "last_summary_time" not in mem: mem["last_summary_time"] = 0
        
        mem["history_buffer"].append(interaction_text)
        mem["interaction_count"] += 1
        
        now = time.time()
        # Resumir si hay 20+ mensajes O si han pasado 30 minutos desde el último resumen
        # 30 minutos = 1800 segundos
        time_since_last = now - mem.get("last_summary_time", 0)
        should_summarize = len(mem["history_buffer"]) >= 20 or (len(mem["history_buffer"]) > 0 and time_since_last > 1800)
        
        self.save_memory(user_id, mem)
        
        return should_summarize

    def check_stale_buffers(self):
        """Revisa todos los usuarios y devuelve los que tienen mensajes pendientes por > 30 min."""
        import time
        users = []
        if not os.path.exists(MEMORY_DIR):
            return users
            
        now = time.time()
        DELAY_30M = 1800
        
        for filename in os.listdir(MEMORY_DIR):
            if filename.endswith(".enc"):
                user_id = filename.replace(".enc", "")
                mem = self.get_memory(user_id)
                
                buffer = mem.get("history_buffer", [])
                last_sum = mem.get("last_summary_time", 0)
                
                if buffer and (now - last_sum > DELAY_30M):
                    users.append(user_id)
        return users

    def get_buffer_and_summary(self, user_id):
        mem = self.get_memory(user_id)
        return mem.get("summary", ""), mem.get("history_buffer", [])

    def update_summary(self, user_id, new_summary):
        """Actualiza el resumen, limpia el buffer y guarda archivo plano."""
        import time
        mem = self.get_memory(user_id)
        mem["summary"] = new_summary
        mem["history_buffer"] = [] # Limpiar buffer
        mem["last_summary_time"] = time.time()
        self.save_memory(user_id, mem)
        
        # Guardar copia plana del resumen
        self._save_summary_plaintext(user_id, new_summary)

    def _save_summary_plaintext(self, user_id, summary_text):
        """Guarda el resumen en un archivo de texto plano visible."""
        SUMMARY_DIR = "data/memory/summaries"
        if not os.path.exists(SUMMARY_DIR):
            os.makedirs(SUMMARY_DIR)
            
        file_path = os.path.join(SUMMARY_DIR, f"{user_id}.txt")
        try:
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(summary_text)
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
        mem["last_channel_id"] = channel_id
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

    # --- MEMORIA TEMPORAL (QUEUE) ---
    QUEUE_FILE = "data/memory/queue.json"

    def _load_queue(self):
        if os.path.exists(self.QUEUE_FILE):
            try:
                with open(self.QUEUE_FILE, "r", encoding="utf-8") as f:
                    return json.load(f)
            except:
                return []
        return []

    def _save_queue(self, queue_data):
        # Asegurar directorio
        os.makedirs(os.path.dirname(self.QUEUE_FILE), exist_ok=True)
        with open(self.QUEUE_FILE, "w", encoding="utf-8") as f:
            json.dump(queue_data, f, ensure_ascii=False, indent=2)

    def add_to_queue(self, user_id, text):
        """Añade una interacción a la cola temporal."""
        import time
        queue = self._load_queue()
        queue.append({
            "user_id": str(user_id),
            "text": text,
            "timestamp": time.time()
        })
        self._save_queue(queue)

    def get_queued_interactions(self, user_id):
        """Recupera interacciones recientes de la cola para este usuario."""
        queue = self._load_queue()
        user_id = str(user_id)
        # Filtrar mensajes de este usuario
        return [item["text"] for item in queue if item.get("user_id") == user_id]

    def process_queue(self):
        """
        Mueve items de la cola temporal a la permanente si tienen > 30 min.
        Retorna lista de user_ids que necesitan resumen.
        """
        import time
        queue = self._load_queue()
        if not queue: return []

        now = time.time()
        new_queue = []
        users_to_summarize = set()
        
        # 5 minutos = 300 segundos (Antes 30 min)
        DELAY_SECONDS = 300 

        for item in queue:
            if now - item["timestamp"] > DELAY_SECONDS:
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
