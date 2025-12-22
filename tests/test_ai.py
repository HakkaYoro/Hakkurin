import unittest
from unittest.mock import MagicMock, patch
import json
import asyncio
from core.ai_handler import GeminiBrain

class TestAIHandler(unittest.TestCase):
    def setUp(self):
        self.brain = GeminiBrain()

    @patch('core.ai_handler.genai.Client')
    def test_initialization(self, mock_client):
        self.brain.keys = ["fake_key"]
        self.brain._initialize_client()
        mock_client.assert_called_with(api_key="fake_key")
        self.assertIsNotNone(self.brain.client)

    @patch('core.ai_handler.genai.Client')
    def test_analyze_interaction_json(self, mock_client):
        # Configurar mock para devolver JSON
        mock_response = MagicMock()
        mock_response.text = '{"intent": "reply", "response_content": "Hola", "is_talking_to_me": true}'
        
        mock_client_instance = mock_client.return_value
        mock_client_instance.models.generate_content.return_value = mock_response
        
        self.brain.client = mock_client_instance
        
        # Ejecutar async test
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(self.brain.analyze_interaction("Hola", "Memoria", []))
        
        self.assertEqual(result["intent"], "reply")
        self.assertEqual(result["response_content"], "Hola")
        self.assertTrue(result["is_talking_to_me"])
        loop.close()

    def test_key_usage_tracking(self):
        usage = self.brain._get_usage(0)
        initial_count = usage.requests_today
        usage.register_request()
        self.assertEqual(usage.requests_today, initial_count + 1)

if __name__ == '__main__':
    unittest.main()
