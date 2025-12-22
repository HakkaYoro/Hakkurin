import unittest
import time
import asyncio
from core.conversation_manager import ConversationManager

class TestConversationManager(unittest.TestCase):
    def setUp(self):
        # Reset singleton
        ConversationManager._instance = None
        self.cm = ConversationManager()

    def test_create_session(self):
        session = self.cm.create_or_update_session(100, 200)
        self.assertIsNotNone(session)
        self.assertEqual(session.channel_id, 100)
        self.assertEqual(session.user_id, 200)
        self.assertTrue(session.is_active)

    def test_context_management(self):
        session = self.cm.create_or_update_session(100, 200)
        session.add_context("Hola")
        session.add_context("Mundo")
        
        context = session.get_context_text()
        self.assertEqual(len(context), 2)
        self.assertEqual(context[0], "Hola")
        self.assertEqual(context[1], "Mundo")

    def test_context_cleanup_24h(self):
        session = self.cm.create_or_update_session(100, 200)
        
        # Mensaje antiguo (25 horas atrás)
        old_time = time.time() - (25 * 3600)
        session.context_messages.append({'timestamp': old_time, 'content': "Old"})
        
        # Mensaje nuevo
        session.add_context("New")
        
        # add_context llama a cleanup, así que "Old" debería desaparecer
        context = session.get_context_text()
        self.assertEqual(len(context), 1)
        self.assertEqual(context[0], "New")

    def test_end_session(self):
        self.cm.create_or_update_session(100, 200)
        self.cm.end_session(100, 200)
        self.assertIsNone(self.cm.get_session(100, 200))

if __name__ == '__main__':
    unittest.main()
