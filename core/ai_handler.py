import random
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

    async def generate_response(self, user_message, user_memory, context_messages=[]):
        """
        Genera una respuesta usando Gemini 2.5 Flash.
        
        Args:
            user_message (str): El mensaje actual del usuario.
            user_memory (str): Resumen de la memoria del usuario.
            context_messages (list): Lista de mensajes previos para contexto (opcional).
        """
        if not self.client:
            self._initialize_client()
            if not self.client:
                return "Error: No hay cerebro disponible (Faltan API Keys)."

        system_prompt = config.get("system_prompt")
        bot_name = config.get("bot_name")
        
        # Construcción del prompt con memoria
        full_prompt = f"""
{system_prompt}

INFORMACIÓN DEL USUARIO (MEMORIA):
{user_memory}

INSTRUCCIONES ADICIONALES:
- Responde de manera natural, corta y directa, como en un chat de Discord.
- No uses hashtags ni formato markdown excesivo a menos que sea parte de tu personalidad.
- Si el usuario es grosero, puedes ser cortante o burlarte, pero mantén el personaje.
- Tu nombre es {bot_name}.

HISTORIAL RECIENTE:
"""
        # Añadir contexto de mensajes anteriores si existen
        for msg in context_messages:
            full_prompt += f"{msg}\n"
            
        full_prompt += f"Usuario: {user_message}\n{bot_name}:"

        try:
            # Intentar generar contenido
            response = self.client.models.generate_content(
                model="gemini-2.5-flash",
                contents=full_prompt,
                config=types.GenerateContentConfig(
                    temperature=0.8, # Creatividad alta para personalidad
                    top_p=0.95,
                    top_k=40,
                    max_output_tokens=200, # Respuestas de chat no muy largas
                )
            )
            return response.text.strip()

        except Exception as e:
            print(f"Error generando respuesta: {e}")
            # Si es error de cuota (429) o autenticación, rotar key y reintentar una vez
            if "429" in str(e) or "403" in str(e) or "quota" in str(e).lower():
                print("Posible error de cuota/auth, rotando key...")
                self._rotate_key()
                # Reintento simple recursivo (cuidado con loops infinitos, aquí solo 1 nivel por lógica de llamada)
                # Para evitar recursión infinita real, podríamos pasar un flag, pero por ahora confiamos en la rotación.
                # Mejor simplemente devolvemos un error genérico si falla tras rotar en la siguiente llamada externa,
                # o intentamos una vez más aquí:
                try:
                    # Re-inicialización ya hecha en _rotate_key
                    if self.client:
                         response = self.client.models.generate_content(
                            model="gemini-2.5-flash",
                            contents=full_prompt
                        )
                         return response.text.strip()
                except Exception as e2:
                    return f"Error crítico de IA: {e2}"
            
            return "..." # Fallback silencioso o error

# Instancia global
brain = GeminiBrain()
