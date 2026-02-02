import os
import json
from google import genai

def list_models():
    try:
        with open("config.json", "r", encoding="utf-8") as f:
            config = json.load(f)
            keys = config.get("gemini_keys", [])
            
        if not keys:
            print("No hay keys en config.json")
            return

        print(f"Probando con la primera key: {keys[0][:10]}...")
        
        client = genai.Client(api_key=keys[0])
        
        print("\nListando modelos disponibles...")
        # La API v1beta suele tener list_models
        # Ajustar según la librería google-genai específica, pero intentaremos lo estándar
        try:
            # En la versión moderna de google-genai, suele ser client.models.list()
            for m in client.models.list():
                print(f"- {m.name}")
                # print(f"  Methods: {m.supported_generation_methods}") # Comentado por si falla
        except Exception as e:
            print(f"Error listando modelos: {e}")
            
    except Exception as e:
        print(f"Error general: {e}")

if __name__ == "__main__":
    list_models()
