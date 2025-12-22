import json
import os

CONFIG_FILE = "config.json"

class ConfigManager:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(ConfigManager, cls).__new__(cls)
            cls._instance.config = {}
            cls._instance.load_config()
        return cls._instance

    def load_config(self):
        if not os.path.exists(CONFIG_FILE):
            # Configuración por defecto si no existe el archivo
            self.config = {
                "bot_token": "",
                "gemini_keys": [],
                "bot_name": "Hakkurin",
                "allowed_channels": [],
                "system_prompt": "Eres Hakkurin, una chica usuaria de Discord con una personalidad e-girl, otaku y fujoshi. Te gusta el anime, el manga y usar emoticonos. Eres sarcástica pero amigable si te tratan bien. Si te ignoran, dejas de hablar. Tienes memoria de con quién hablas.",
                "reply_probability": 0.125
            }
            self.save_config()
        else:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                self.config = json.load(f)

    def save_config(self):
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(self.config, f, indent=4, ensure_ascii=False)

    def get(self, key, default=None):
        return self.config.get(key, default)

    def set(self, key, value):
        self.config[key] = value
        self.save_config()

# Instancia global
config = ConfigManager()
