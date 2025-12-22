import unittest
import time
import asyncio
import json
import os
from unittest.mock import MagicMock, patch, AsyncMock

# Importar módulos a probar
# Ajustamos sys.path para importar desde root
import sys
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from core.memory_manager import MemoryManager
from core.ai_handler import GeminiBrain
from bot.discord_client import HakkurinBot
import logging

# Configurar logging verbose a archivo
logging.basicConfig(
    filename='tests/test_verbose.log',
    level=logging.DEBUG,
    format='%(asctime)s - %(levelname)s - %(message)s',
    filemode='w'
)

class TestNewFeatures(unittest.IsolatedAsyncioTestCase):
    
    def setUp(self):
        # Setup MemoryManager con directorios temporales de prueba
        self.test_dir = "tests/temp_data"
        if not os.path.exists(self.test_dir):
            os.makedirs(self.test_dir)
            
        # Mockear constantes de directorios en MemoryManager
        self.patcher_mem = patch('core.memory_manager.MEMORY_DIR', f"{self.test_dir}/users")
        self.patcher_queue = patch('core.memory_manager.MemoryManager.QUEUE_FILE', f"{self.test_dir}/queue.json")
        self.mock_mem_dir = self.patcher_mem.start()
        self.mock_queue_file = self.patcher_queue.start()
        
        self.memory = MemoryManager()
        
    def tearDown(self):
        self.patcher_mem.stop()
        self.patcher_queue.stop()
        # Limpiar archivos
        import shutil
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir)

    def test_memory_queue_delay(self):
        print("\n--- Test: Cola de Memoria Temporal (30 min) ---")
        user_id = "test_user_queue"
        
        # 1. Añadir a cola
        self.memory.add_to_queue(user_id, "Mensaje 1")
        queue = self.memory._load_queue()
        self.assertEqual(len(queue), 1)
        print("✅ Item añadido a la cola correctamente.")
        
        # 2. Procesar inmediatamente (no debería moverse)
        users = self.memory.process_queue()
        self.assertEqual(len(users), 0)
        mem = self.memory.get_memory(user_id)
        self.assertEqual(len(mem["history_buffer"]), 0)
        print("✅ Item reciente se mantiene en cola (no pasa a permanente).")
        
        # 2.5 Verificar acceso inmediato vía get_memory_summary
        summary_text = self.memory.get_memory_summary(user_id)
        self.assertIn("MEMORIA RECIENTE", summary_text)
        self.assertIn("Mensaje 1", summary_text)
        print("✅ Item en cola es visible inmediatamente en el resumen.")

        # 3. Simular paso del tiempo (6 min, > 5 min)
        # Hack: Modificar timestamp del archivo directamente
        queue[0]["timestamp"] -= 400 # Restar 400 segundos (5 min = 300s)
        self.memory._save_queue(queue)
        
        # 4. Procesar de nuevo
        users = self.memory.process_queue()
        mem = self.memory.get_memory(user_id)
        
        self.assertEqual(len(mem["history_buffer"]), 1)
        self.assertEqual(mem["history_buffer"][0], "Mensaje 1")
        print("✅ Item antiguo (>5 min) movido a memoria permanente.")

    def test_batch_summarization_trigger(self):
        print("\n--- Test: Trigger de Resumen por Lotes (20 msgs) ---")
        user_id = "test_user_batch"
        
        # Inicializar memoria con tiempo reciente para evitar trigger por tiempo
        mem = self.memory.get_memory(user_id)
        mem["last_summary_time"] = time.time()
        self.memory.save_memory(user_id, mem)
        
        # Añadir 19 mensajes
        for i in range(19):
            should = self.memory.add_interaction(user_id, f"Msg {i}")
            self.assertFalse(should, f"Se disparó resumen en mensaje {i+1}")
            
        print("✅ No se disparó resumen con 19 mensajes.")
        
        # Añadir mensaje 20
        should = self.memory.add_interaction(user_id, "Msg 20")
        self.assertTrue(should, "NO se disparó resumen con 20 mensajes")
        print("✅ Se disparó resumen al llegar a 20 mensajes.")

    @patch('core.ai_handler.config')
    def test_gemma_rate_limit(self, mock_config):
        print("\n--- Test: Rate Limit de Gemma (15k tokens) ---")
        mock_config.get.return_value = ["fake_key"]
        brain = GeminiBrain()
        
        # Resetear contadores
        brain.gemma_tokens_this_minute = 0
        brain.gemma_last_reset = time.time()
        
        # 1. Uso normal
        allowed = brain._check_gemma_limit(5000)
        self.assertTrue(allowed)
        brain._update_gemma_usage(5000)
        print("✅ Uso de 5k tokens permitido.")
        
        # 2. Uso que excede (5000 + 11000 > 15000)
        allowed = brain._check_gemma_limit(11000)
        self.assertFalse(allowed)
        print("✅ Uso que excede 15k bloqueado.")

    @patch('core.ai_handler.genai.Client')
    @patch('core.ai_handler.config')
    async def test_fallback_models(self, mock_config, mock_client_cls):
        print("\n--- Test: Modelos Fallback (Detallado) ---")
        mock_config.get.return_value = ["fake_key"]
        
        # Mockear cliente
        mock_client = MagicMock()
        mock_client_cls.return_value = mock_client
        
        brain = GeminiBrain()
        brain.client = mock_client

        # --- CASO 1: ELIMINADO (Flash Lite ya no se usa) ---
        # Se mantiene el código para referencia o futura expansión
        pass

        # --- CASO 2: Fallo de Primarios Y Lite -> Éxito en Gemma ---
        print("\n[Caso 2] Primarios y Lite fallan, Gemma funciona:")
        async def mock_generate_gemma(func, model, contents, config):
            print(f"  -> Mock intentando con: {model}")
            if "preview" in model or "flash" in model: # Falla todo lo que tenga flash (incluido lite)
                raise Exception("429 Resource Exhausted")
            if "gemma" in model:
                mock_resp = MagicMock()
                mock_resp.text = f"Contenido generado por {model}"
                return mock_resp
            raise Exception("Modelo inesperado")

        with patch('asyncio.to_thread', side_effect=mock_generate_gemma):
            # Resetear estado
            brain.fallback_until = 0
            result = await brain._generate_with_retry("test", None, is_json=False)
            print(f"  RESULTADO: {result}")
            self.assertIn("gemma-3-27b-it", result)

    @patch('bot.discord_client.HakkurinBot.get_channel')
    async def test_sleep_mode(self, mock_get_channel):
        print("\n--- Test: Modo Sueño ---")
        # Mockear bot
        bot = HakkurinBot()
        bot.status_messages = {"tired": ["Tired"], "recovery": ["Back"]}
        
        # Mock channel
        mock_channel = AsyncMock()
        mock_get_channel.return_value = mock_channel
        
        # 1. Activar sueño
        await bot.enter_sleep_mode(mock_channel)
        
        self.assertTrue(bot.is_sleeping)
        self.assertTrue(bot.sleep_until > time.time() + 7000) # > 2 horas aprox
        mock_channel.send.assert_called_with("Tired")
        print("✅ Modo sueño activado y mensaje enviado.")
        
        # 2. Verificar que on_message ignora
        msg = MagicMock()
        msg.author.bot = False
        await bot.on_message(msg)
        # No podemos verificar fácilmente que NO hizo nada sin mockear todo, 
        # pero si is_sleeping es True, retorna al inicio.
        
        # 3. Test Recuperación (Simular paso del tiempo)
        bot.sleep_until = time.time() - 1 # Ya pasó el tiempo
        bot.last_active_channel_id = 123
        
        # Mockear brain.test_api_connection
        with patch('core.ai_handler.brain.test_api_connection', new_callable=AsyncMock) as mock_test:
            mock_test.return_value = True
            
            await bot.recovery_check_task() # Ejecutar una iteración
            
            self.assertFalse(bot.is_sleeping)
            mock_channel.send.assert_called_with("Back")
            print("✅ Recuperación exitosa tras test de API positivo.")

    def test_time_based_summarization(self):
        print("\n--- Test: Resumen por Tiempo (>30m) ---")
        user_id = "test_user_time"
        
        # 1. Añadir interacción (menos de 20)
        self.memory.add_interaction(user_id, "Hola")
        mem = self.memory.get_memory(user_id)
        mem["last_summary_time"] = time.time() # Recién resumido
        self.memory.save_memory(user_id, mem)
        
        # 2. Verificar que NO pide resumen inmediato
        should = self.memory.add_interaction(user_id, "Otro mensaje")
        self.assertFalse(should, "No debería resumir con pocos mensajes y poco tiempo.")
        
        # 3. Simular paso del tiempo (35 min)
        mem = self.memory.get_memory(user_id)
        mem["last_summary_time"] = time.time() - 2100 # > 30m (1800s)
        self.memory.save_memory(user_id, mem)
        
        # 4. Verificar trigger por tiempo al añadir interacción
        should = self.memory.add_interaction(user_id, "Trigger msg")
        self.assertTrue(should, "Debería resumir por tiempo (>30m).")
        print("✅ Trigger por tiempo al añadir interacción funciona.")
        
        # 5. Verificar check_stale_buffers (sin interacción nueva)
        # Resetear
        mem = self.memory.get_memory(user_id)
        mem["last_summary_time"] = time.time() - 2100
        # Asegurar que hay buffer
        mem["history_buffer"] = ["Mensaje pendiente"]
        self.memory.save_memory(user_id, mem)
        
        stale_users = self.memory.check_stale_buffers()
        self.assertIn(user_id, stale_users)
        print("✅ check_stale_buffers detecta usuarios inactivos con buffer viejo.")

    def test_forced_model_summarization(self):
        print("\n--- Test: Resumen Forzado con Modelo Específico ---")
        from core.ai_handler import brain
        
        # Mockear _generate_with_retry en la instancia real de brain
        original_generate = brain._generate_with_retry
        brain._generate_with_retry = AsyncMock(return_value="Resumen forzado")
        
        async def run_test():
            await brain.generate_summary("Old", ["New"], "user_force", model_name="gemma-3-27b-it")
        
        asyncio.run(run_test())
        
        # Verificar que se llamó con force_model="gemma-3-27b-it"
        call_args = brain._generate_with_retry.call_args
        self.assertEqual(call_args.kwargs.get('force_model'), "gemma-3-27b-it")
        print("✅ generate_summary pasó correctamente el modelo forzado.")
        
        # Restaurar
        brain._generate_with_retry = original_generate

if __name__ == '__main__':
    unittest.main()
