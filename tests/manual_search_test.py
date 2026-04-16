import asyncio
import sys
import os

# Añadir directorio raíz al path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.ai_handler import brain
from core.config_manager import config

async def test_search():
    print(">>> Iniciando prueba manual de Web Search...")
    
    # Pregunta que requiere búsqueda reciente
    question = "Precio dolar Venezuela hoy"
    
    print(f"Pregunta: {question}")
    
    # Simulamos una interacción directa
    # Nota: analyze_interaction llama a _generate_with_nanogpt con enable_search=True
    response = await brain.analyze_interaction(
        user_text=question,
        user_id="test_user",
        user_name="Tester",
        is_session_active=True,
        is_dm=True # Para simplificar prompt
    )
    
    print("\n>>> Respuesta del Brain:")
    print(response)
    
    if response and response.get("response_content"):
        print("\n>>> Contenido de respuesta:")
        for msg in response["response_content"]:
            print(f"- {msg}")
    else:
        print("\n>>> ERROR: No hubo respuesta o contenido vacío.")

if __name__ == "__main__":
    asyncio.run(test_search())
