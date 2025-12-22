import random
import json
from google import genai
from google.genai import types
from core.config_manager import config

class GeminiBrain:
    def __init__(self):
        self.keys = config.get("gemini_keys", [])
        self.current_key_index = 0
        self.client = None
        self._initialize_client()

    def _initialize_client(self):
        if not self.keys:
            print("ADVERTENCIA: No hay API Keys de Gemini configuradas.")
            return
        
        # Rotación simple: intentar con la llave actual
        api_key = self.keys[self.current_key_index]
        try:
            self.client = genai.Client(api_key=api_key)
            print(f"Cliente Gemini inicializado con la llave índice {self.current_key_index}")
        except Exception as e:
            print(f"Error al inicializar cliente con llave {self.current_key_index}: {e}")
            self._rotate_key()

    def _rotate_key(self):
        if not self.keys:
            return
        
        original_index = self.current_key_index
        self.current_key_index = (self.current_key_index + 1) % len(self.keys)
        
        print(f"Rotando API Key de {original_index} a {self.current_key_index}")
        self._initialize_client()

    async def analyze_interaction(self, user_message, user_memory, context_messages=[], is_session_active=False):
        """
        Analiza la interacción y decide qué hacer usando una respuesta estructurada en JSON.
        """
        if not self.client:
            self._initialize_client()
            if not self.client:
                return {"intent": "error", "response_content": "No brain available."}

        system_prompt = config.get("system_prompt")
        bot_name = config.get("bot_name")
        
        # Prompt diseñado para "Over-engineering" de la decisión
        full_prompt = f"""
{system_prompt}

ESTADO ACTUAL:
- Sesión Activa: {"SÍ" if is_session_active else "NO"} (Si es SÍ, ya estabas hablando con esta persona).
- Memoria del Usuario: {user_memory}

HISTORIAL RECIENTE:
{chr(10).join(context_messages)}
Usuario: "{user_message}"

TU TAREA:
Analiza el mensaje del usuario y decide tu reacción. Responde EXCLUSIVAMENTE con un objeto JSON válido con este formato:
{{
  "is_talking_to_me": boolean, // True si el mensaje va dirigido a ti o es relevante para la conversación actual. False si hablan de otra cosa.
  "intent": "reply" | "ignore" | "complain" | "new_topic", // "reply": responder normal. "ignore": no hacer nada. "complain": quejarse porque te ignoran o te molestan. "new_topic": cambiar de tema.
  "thought_process": "string", // Tu razonamiento interno de por qué actúas así. Sé detallada.
  "response_content": "string" // El texto de tu respuesta (si intent es ignore, esto puede estar vacío).
}}

REGLAS DE COMPORTAMIENTO:
1. Si 'Sesión Activa' es SÍ, asume que te hablan a ti a menos que sea muy obvio que no.
2. Si te ignoran en una sesión activa, puedes elegir "complain" para llamar la atención o "ignore" para dejar morir la charla.
3. Si 'Sesión Activa' es NO, solo responde si te mencionan, te interesa mucho el tema o quieres molestar (probabilidad baja).
4. Sé fiel a tu personalidad e-girl/otaku/sarcástica.
"""

        try:
            response = self.client.models.generate_content(
                model="gemini-2.5-flash",
                contents=full_prompt,
                config=types.GenerateContentConfig(
                    temperature=0.85,
                    top_p=0.95,
                    top_k=40,
                    response_mime_type="application/json" # Forzar salida JSON
                )
            )
            
            # Limpiar y parsear JSON por si acaso
            text_response = response.text.strip()
            # A veces el modelo pone bloques de código markdown ```json ... ```
            if text_response.startswith("```"):
                text_response = text_response.strip("`").replace("json\n", "").strip()
            
            return json.loads(text_response)

        except Exception as e:
            print(f"Error generando respuesta JSON: {e}")
            if "429" in str(e) or "403" in str(e) or "quota" in str(e).lower():
                print("Posible error de cuota/auth, rotando key...")
                self._rotate_key()
                try:
                    if self.client:
                         response = self.client.models.generate_content(
                            model="gemini-2.5-flash",
                            contents=full_prompt,
                             config=types.GenerateContentConfig(response_mime_type="application/json")
                        )
                         text_response = response.text.strip()
                         if text_response.startswith("```"):
                            text_response = text_response.strip("`").replace("json\n", "").strip()
                         return json.loads(text_response)
                except Exception as e2:
                    return {"intent": "error", "response_content": f"Error crítico de IA: {e2}"}
            
            return {"intent": "ignore", "response_content": "", "thought_process": f"Error: {e}"}

# Instancia global
brain = GeminiBrain()
