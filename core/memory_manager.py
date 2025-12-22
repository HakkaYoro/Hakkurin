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
        """Añade una interacción al buffer y devuelve True si es hora de resumir."""
        mem = self.get_memory(user_id)
        
        # Asegurar que existan los campos nuevos en memorias viejas
        if "history_buffer" not in mem: mem["history_buffer"] = []
        if "summary" not in mem: mem["summary"] = ""
        
        mem["history_buffer"].append(interaction_text)
        mem["interaction_count"] += 1
        
        should_summarize = len(mem["history_buffer"]) >= 20
        self.save_memory(user_id, mem)
        
        return should_summarize

    def get_buffer_and_summary(self, user_id):
        mem = self.get_memory(user_id)
        return mem.get("summary", ""), mem.get("history_buffer", [])

    def update_summary(self, user_id, new_summary):
        """Actualiza el resumen y limpia el buffer."""
        mem = self.get_memory(user_id)
        mem["summary"] = new_summary
        mem["history_buffer"] = [] # Limpiar buffer
        self.save_memory(user_id, mem)

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
        
        if profile.get("name"):
            final_text += f"Nombre: {profile['name']}\n"
        if profile.get("likes"):
            final_text += f"Gustos: {', '.join(profile['likes'])}\n"
        
        return final_text

# Instancia global
memory = MemoryManager()
