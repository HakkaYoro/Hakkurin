import unittest
import os
import shutil
from core.memory_manager import MemoryManager

class TestMemoryManager(unittest.TestCase):
    def setUp(self):
        # Usar directorio de memoria de prueba
        self.test_base_dir = "memory_test"
        self.test_memory_dir = os.path.join(self.test_base_dir, "users")
        self.test_key_file = os.path.join(self.test_base_dir, "secret.key")
        
        # Monkey patch de las rutas en la clase
        import core.memory_manager
        self.original_dir = core.memory_manager.MEMORY_DIR
        self.original_key = core.memory_manager.KEY_FILE
        
        core.memory_manager.MEMORY_DIR = self.test_memory_dir
        core.memory_manager.KEY_FILE = self.test_key_file
        
        # Reiniciar instancia
        self.mm = MemoryManager()

    def tearDown(self):
        if os.path.exists(self.test_base_dir):
            shutil.rmtree(self.test_base_dir)
        
        # Restaurar
        import core.memory_manager
        core.memory_manager.MEMORY_DIR = self.original_dir
        core.memory_manager.KEY_FILE = self.original_key

    def test_key_creation(self):
        self.assertTrue(os.path.exists(self.test_key_file))

    def test_save_and_load_memory(self):
        user_id = "12345"
        data = {
            "profile": {"name": "TestUser"},
            "interaction_count": 1
        }
        self.mm.save_memory(user_id, data)
        
        loaded_data = self.mm.get_memory(user_id)
        self.assertEqual(loaded_data["profile"]["name"], "TestUser")
        self.assertEqual(loaded_data["interaction_count"], 1)

    def test_encryption(self):
        user_id = "enc_test"
        data = {"secret": "hidden"}
        self.mm.save_memory(user_id, data)
        
        file_path = os.path.join(self.test_memory_dir, f"{user_id}.enc")
        with open(file_path, "rb") as f:
            content = f.read()
        
        # No debería ser JSON plano
        self.assertNotIn(b"hidden", content)
        # Debería ser desencriptable
        decrypted = self.mm.cipher.decrypt(content)
        self.assertIn(b"hidden", decrypted)

if __name__ == '__main__':
    unittest.main()
