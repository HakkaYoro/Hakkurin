import os
import sys
import asyncio
from google import genai

# Añadir root al path para importar config
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from core.config_manager import config

def list_models():
    keys = config.get("gemini_keys", [])
    if not keys:
        print("No hay keys configuradas.")
        return

    print(f"Usando API Key: {keys[0][:5]}...")
    client = genai.Client(api_key=keys[0])

    print("\n--- Modelos Disponibles ---")
    try:
        # Listar modelos
        print("Listando modelos...")
        for model in client.models.list():
            print(f"Model: {model.name}")
            # Descomentar para ver atributos si es necesario
            # print(dir(model)) 
            # print(f"- {model.name} ({getattr(model, 'display_name', 'No display name')})")
    except Exception as e:
        print(f"Error listando modelos: {e}")

if __name__ == "__main__":
    list_models()
