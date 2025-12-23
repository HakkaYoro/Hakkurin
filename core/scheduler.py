import json
import re
from datetime import datetime
import logging

class Scheduler:
    def __init__(self):
        self.logger = logging.getLogger("Scheduler")

    def parse_scheduled_actions(self, memory_text):
        """
        Extrae el bloque JSON de acciones programadas del texto de la memoria.
        """
        if not memory_text:
            return []

        # Buscar bloque JSON
        # Regex para encontrar contenido entre ```json y ``` o simplemente el último bloque []
        json_match = re.search(r'```json\s*(\[.*?\])\s*```', memory_text, re.DOTALL)
        
        if not json_match:
            # Intentar buscar solo los corchetes si el formato markdown falla
            json_match = re.search(r'(\[\s*\{.*\}\s*\])', memory_text, re.DOTALL)

        if json_match:
            json_str = json_match.group(1)
            try:
                actions = json.loads(json_str)
                return actions
            except json.JSONDecodeError as e:
                self.logger.error(f"Error decodificando JSON de acciones: {e}")
                return []
        
        return []

    def check_due_actions(self, actions):
        """
        Filtra las acciones que deben ejecutarse ahora.
        """
        due_actions = []
        now = datetime.now()
        
        for action in actions:
            trigger_time_str = action.get("trigger_time")
            if not trigger_time_str:
                continue
                
            try:
                # Formato esperado: YYYY-MM-DD HH:MM
                trigger_time = datetime.strptime(trigger_time_str, "%Y-%m-%d %H:%M")
                
                # Si el tiempo ya pasó (y no es demasiado viejo, ej. < 1 hora para evitar loops infinitos de cosas viejas)
                # Ojo: Para evitar loops, el sistema principal debe borrar la acción o marcarla.
                # Aquí solo decimos "esto ya toca".
                time_diff = now - trigger_time
                
                # Ejecutar si ya pasó y no hace más de 5 minutos (para evitar spam de cosas viejas si el bot estuvo apagado)
                # O si el usuario quiere que se ejecute "al encender", podríamos ampliar la ventana.
                # Por ahora: ventana de 10 minutos.
                if 0 <= time_diff.total_seconds() <= 600: 
                    due_actions.append(action)
                    
            except ValueError:
                self.logger.error(f"Formato de fecha inválido: {trigger_time_str}")
                continue
                
        return due_actions

scheduler = Scheduler()
