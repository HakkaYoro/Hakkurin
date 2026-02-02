import asyncio
import sys
import os
import json

# Add project root to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from core.ai_handler import brain
from core.config_manager import config

async def test_reminder_removal():
    print("--- INICIANDO TEST DE ELIMINACION DE RECORDATORIOS ---")
    
    # 1. Simular Memoria Previa con un recordatorio pendiente
    current_summary = """
### ESTADO ACTUAL
* Vibe: Atenta
* Energía: Media

### SCHEDULED_ACTIONS (JSON)
```json
[
  {
    "trigger_time": "2025-12-24 10:00",
    "action_description": "Recordar a Hakka comprar leche",
    "target_user_id": "321799812595056645"
  }
]
```
"""
    
    # 2. Simular Interacciones Recientes donde YA SE HIZO
    recent_interactions = [
        "[YO DIJE/HICE]: EJECUTÉ RECORDATORIO: Recordar a Hakka comprar leche para Sistema"
    ]
    
    print("\nCONTEXTO:")
    print(f"- Memoria Previa: Tiene recordatorio pendiente.")
    # print(f"- Interacciones: {recent_interactions[0]}") # Comentado por error de encoding en Windows
    print("\nGenerando nuevo resumen con IA...")

    # 3. Generar Resumen
    # Usamos el ID especial para activar el prompt de auto-reflexión
    new_summary = await brain.generate_summary(
        current_summary, 
        recent_interactions, 
        "hakkurin_internal_self"
    )
    
    # print("\n--- RESUMEN GENERADO ---")
    # print(new_summary)
    
    # print("\n--- VERIFICACIÓN ---")
    if "Recordar a Hakka comprar leche" not in new_summary or '"action_description": "Recordar a Hakka comprar leche"' not in new_summary:
        print("EXITO: El recordatorio completado FUE ELIMINADO del JSON.")
    else:
        print("FALLO: El recordatorio completado SIGUE en el JSON.")

if __name__ == "__main__":
    asyncio.run(test_reminder_removal())
