import unittest
import time
from core.conversation_manager import ConversationManager

class TestImagePersistence(unittest.TestCase):
    def setUp(self):
        # Reset singleton
        ConversationManager._instance = None
        self.cm = ConversationManager()
        self.channel_id = 12345
        self.ctx = self.cm.get_channel_context(self.channel_id)

    def test_add_and_get_image(self):
        # Simular datos de imagen
        img_data = b"fake_image_data"
        mime = "image/png"
        
        self.ctx.add_image(img_data, mime)
        
        recent = self.ctx.get_recent_images(seconds=60)
        self.assertEqual(len(recent), 1)
        self.assertEqual(recent[0][0], img_data)
        self.assertEqual(recent[0][1], mime)

    def test_image_expiration(self):
        # Añadir imagen "vieja"
        img_data = b"old_image"
        mime = "image/jpeg"
        
        # Hack para simular tiempo pasado: añadir y luego modificar timestamp manualmente
        self.ctx.add_image(img_data, mime)
        self.ctx.recent_images[0]['timestamp'] = time.time() - 100 # 100 segundos atrás
        
        # Pedir imágenes de hace 60 segundos
        recent = self.ctx.get_recent_images(seconds=60)
        self.assertEqual(len(recent), 0)
        
        # Pedir imágenes de hace 120 segundos
        recent_older = self.ctx.get_recent_images(seconds=120)
        self.assertEqual(len(recent_older), 1)

    def test_cleanup_removes_very_old_images(self):
        # Añadir imagen muy vieja que debería ser limpiada por _cleanup
        img_data = b"ancient_image"
        mime = "image/jpeg"
        
        self.ctx.add_image(img_data, mime)
        # Modificar timestamp a > 300 segundos (límite de cleanup)
        self.ctx.recent_images[0]['timestamp'] = time.time() - 301
        
        # Trigger cleanup añadiendo otra cosa
        self.ctx.add_message("User", 1, "Trigger cleanup")
        
        # La imagen vieja debería haber desaparecido de la lista interna
        self.assertEqual(len(self.ctx.recent_images), 0)

    def test_multiple_images(self):
        self.ctx.add_image(b"img1", "image/png")
        time.sleep(0.1)
        self.ctx.add_image(b"img2", "image/jpeg")
        
        recent = self.ctx.get_recent_images()
        self.assertEqual(len(recent), 2)
        # El orden se mantiene (append)
        self.assertEqual(recent[0][0], b"img1")
        self.assertEqual(recent[1][0], b"img2")

if __name__ == '__main__':
    unittest.main()
