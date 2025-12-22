import unittest
import os
import json
from core.config_manager import ConfigManager

class TestConfigManager(unittest.TestCase):
    def setUp(self):
        # Usar un archivo de config temporal
        self.test_config_file = "test_config.json"
        # Parchear la clase para usar otro archivo (un poco hacky pero efectivo para singleton simple)
        # Nota: En un diseño ideal, se inyectaría el path. Por ahora, modificamos la constante global en el módulo si fuera posible,
        # o simplemente testeamos que lea/escriba.
        # Dado que es singleton y hardcodea el archivo, vamos a renombrar el real temporalmente si existe.
        if os.path.exists("config.json"):
            os.rename("config.json", "config.json.bak")

    def tearDown(self):
        if os.path.exists("test_config.json"):
            os.remove("test_config.json")
        if os.path.exists("config.json"):
            os.remove("config.json") # Limpiar el creado por el test
        if os.path.exists("config.json.bak"):
            os.rename("config.json.bak", "config.json")

    def test_singleton(self):
        c1 = ConfigManager()
        c2 = ConfigManager()
        self.assertIs(c1, c2)

    def test_default_values(self):
        # Forzar recarga
        ConfigManager._instance = None
        cm = ConfigManager()
        self.assertEqual(cm.get("bot_name"), "Hakkurin")
        self.assertEqual(cm.get("reply_probability"), 0.125)

    def test_set_get(self):
        cm = ConfigManager()
        cm.set("test_key", 123)
        self.assertEqual(cm.get("test_key"), 123)
        
        # Verificar persistencia
        with open("config.json", "r") as f:
            data = json.load(f)
        self.assertEqual(data["test_key"], 123)

if __name__ == '__main__':
    unittest.main()
