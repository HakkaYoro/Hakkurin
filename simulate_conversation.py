import asyncio
import os
import time
from core.ai_handler import GeminiBrain
from core.conversation_manager import ConversationManager
from core.memory_manager import MemoryManager

# Configurar entorno para pruebas
os.environ["BOT_TOKEN"] = "TEST_TOKEN" 

async def simulate():
    print("--- INICIANDO SIMULACIÓN DE HAKKURIN ---")
    
    brain = GeminiBrain()
    # Forzar inicialización si es necesario (el init ya lo hace)
    
    cm = ConversationManager()
    mm = MemoryManager()
    
    # ID de usuario y canal simulados
    user_id = "sim_user_01"
    channel_id = "sim_channel_01"
    user_name = "TestUser"
    
    # Limpiar memoria previa para empezar de cero
    if os.path.exists(f"memory/users/{user_id}.enc"):
        os.remove(f"memory/users/{user_id}.enc")
    
    print(f"\n[SISTEMA] Usuario simulado: {user_name} ({user_id})")
    
    # Escenarios de prueba
    scenarios = [
        ("Hola, ¿quién eres?", "Saludo inicial"),
        ("¿Te gusta el anime?", "Pregunta sobre gustos"),
        ("Ignorame por favor.", "Prueba de ignorar"),
        ("...", "Mensaje vacío/corto"),
        ("Oye, ¿sigues ahí?", "Re-enganche"),
        ("Eres una tonta.", "Insulto/Provocación"),
        ("Perdón, no quise decir eso. ¿Hacemos las paces?", "Disculpa"),
    ]
    
    session = cm.create_or_update_session(channel_id, user_id)
    
    for user_msg, desc in scenarios:
        print(f"\n--- Escenario: {desc} ---")
        print(f"👤 {user_name}: {user_msg}")
        
        # 1. Actualizar sesión y contexto
        session.add_context(f"{user_name}: {user_msg}")
        
        # 2. Obtener memoria
        user_memory = mm.get_memory_summary(user_id)
        
        # 3. Analizar interacción (Brain)
        # Simulamos historial reciente con el contexto de la sesión
        recent_history = session.get_context_text()
        
        print("🧠 Hakkurin pensando...")
        start_time = time.time()
        result = await brain.analyze_interaction(user_msg, user_memory, recent_history)
        duration = time.time() - start_time
        
        # 4. Mostrar resultados internos
        print(f"⏱️ Tiempo de respuesta: {duration:.2f}s")
        print(f"🤔 Pensamiento: {result.get('thought_process')}")
        print(f"🎯 Intención: {result.get('intent')}")
        print(f"👀 ¿Me habla a mí?: {result.get('is_talking_to_me')}")
        
        # 5. Mostrar respuesta
        response_content = result.get('response_content')
        if response_content:
            if isinstance(response_content, list):
                for msg in response_content:
                    print(f"🤖 Hakkurin: {msg}")
                full_text = " ".join(response_content)
                session.add_context(f"Hakkurin: {full_text}")
            else:
                print(f"🤖 Hakkurin: {response_content}")
                session.add_context(f"Hakkurin: {response_content}")
        else:
            print("🤖 Hakkurin: (Silencio)")
            
        # Pequeña pausa para realismo
        await asyncio.sleep(1)

    print("\n--- FIN DE SIMULACIÓN ---")

if __name__ == "__main__":
    asyncio.run(simulate())
