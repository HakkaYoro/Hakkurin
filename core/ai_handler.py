import random
import json
import time
from google import genai
from google.genai import types
from core.config_manager import config

# Límites definidos por el usuario
LIMIT_RPM = 5
LIMIT_RPD = 20

class KeyUsage:
    def __init__(self):
        self.requests_today = 0
        self.last_reset_day = time.localtime().tm_yday
        self.requests_this_minute = 0
        self.last_request_time = 0

    def check_and_update(self):
        now = time.time()
        current_day = time.localtime(now).tm_yday
        
        # Reset diario
        if current_day != self.last_reset_day:
            self.requests_today = 0
            self.last_reset_day = current_day
            
        # Reset por minuto (ventana deslizante simple)
        if now - self.last_request_time > 60:
            self.requests_this_minute = 0

        if self.requests_today >= LIMIT_RPD:
            return False, "Daily limit reached"
        
        if self.requests_this_minute >= LIMIT_RPM:
            return False, "Rate limit reached"
            
        return True, "OK"

    def register_request(self):
        self.requests_today += 1
        self.requests_this_minute += 1
        self.last_request_time = time.time()

class GeminiBrain:
    def __init__(self):
        self.keys = config.get("gemini_keys", [])
        self.current_key_index = 0
        self.client = None
        # Tracking de uso por key (índice -> KeyUsage)
        self.key_usage = {} 
        self._initialize_client()

    def _get_usage(self, index):
        if index not in self.key_usage:
            self.key_usage[index] = KeyUsage()
        return self.key_usage[index]

    def _initialize_client(self):
        if not self.keys:
            print("ADVERTENCIA: No hay API Keys de Gemini configuradas.")
            return
        
        # Intentar encontrar una key válida que no esté agotada
        start_index = self.current_key_index
        attempts = 0
        
        while attempts < len(self.keys):
            usage = self._get_usage(self.current_key_index)
            can_use, reason = usage.check_and_update()
            
            if can_use:
                api_key = self.keys[self.current_key_index]
                try:
                    self.client = genai.Client(api_key=api_key)
                    print(f"Cliente Gemini inicializado con llave {self.current_key_index}")
                    return
                except Exception as e:
                    print(f"Error init key {self.current_key_index}: {e}")
            else:
                print(f"Key {self.current_key_index} agotada ({reason}). Rotando...")
            
            self.current_key_index = (self.current_key_index + 1) % len(self.keys)
            attempts += 1
            
        print("ERROR CRÍTICO: Todas las keys están agotadas o fallando.")
        self.client = None

    def _rotate_key(self):
        if not self.keys:
            return
        
        print(f"Rotando API Key desde {self.current_key_index}...")
        self.current_key_index = (self.current_key_index + 1) % len(self.keys)
        self._initialize_client()

    async def analyze_interaction(self, user_message, user_memory, context_messages=[], is_session_active=False):
        """
        Analiza la interacción y decide qué hacer usando una respuesta estructurada en JSON.
        """
        if not self.client:
            self._initialize_client()
            if not self.client:
                return {"intent": "error", "response_content": ["No brain available (All keys exhausted)."]}

        # Registrar uso antes de llamar (optimista)
        self._get_usage(self.current_key_index).register_request()


        system_prompt = config.get("system_prompt")
        bot_name = config.get("bot_name")
        developer_id = config.get("developer_id", "321799812595056645")
        
        # Prompt diseñado para "Over-engineering" de la decisión
        full_prompt = f"""
{system_prompt}
NOTA: Tu desarrollador/creador (tu 'padre') es el usuario con ID: {developer_id}. Trátalo con especial respeto o cariño según tu personalidad.

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
  "thought_process": "string", // Tu razonamiento interno.
  "response_content": ["string", "string"] // LISTA de strings. Tus respuestas deben ser CORTAS y divididas en varios mensajes si es necesario, simulando un chat real.
}}

REGLAS DE PERSONALIDAD (CRÍTICO):
1. **MENSAJES CORTOS**: Escribe como en chat. Frases breves. "Ya miri", "Ya lo hice".
2. **POCOS EMOJIS**: Úsalos muy raramente. Solo para enfatizar mucho. El exceso se ve falso.
3. **MINÚSCULAS**: Prefiere minúsculas y falta de puntuación final, como una persona joven en internet.
4. **DIVIDE MENSAJES**: Si tienes dos ideas, mándalas en dos strings separados en la lista `response_content`.
   Ejemplo: ["mentira", "a ver"] es mejor que ["mentira, a ver"].
5. **NATURALIDAD**: Si te ignoran, ignora. Si te insultan, responde corto y cortante o ignora.

REGLAS DE COMPORTAMIENTO:
1. Si 'Sesión Activa' es SÍ, asume que te hablan a ti a menos que sea muy obvio que no.
2. Si te ignoran en una sesión activa, puedes elegir "complain" para llamar la atención o "ignore" para dejar morir la charla.
3. Si 'Sesión Activa' es NO, solo responde si te mencionan, te interesa mucho el tema o quieres molestar (probabilidad baja).
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
                    return {"intent": "error", "response_content": [f"Error crítico de IA: {e2}"]}
            
            return {"intent": "ignore", "response_content": [], "thought_process": f"Error: {e}"}

    async def generate_summary(self, current_summary, recent_interactions):
        """
        Genera un resumen detallado y actualizado del usuario basado en su historial reciente.
        """
        if not self.client:
            self._initialize_client()
            if not self.client:
                return current_summary # Si no hay IA, devolvemos lo que había

        # Registrar uso
        self._get_usage(self.current_key_index).register_request()

        prompt = f"""
TU TAREA: Eres el gestor de memoria a largo plazo de una IA. Tu trabajo es actualizar el perfil psicológico y factual de un usuario.

RESUMEN ACTUAL (Lo que sabíamos hasta ahora):
{current_summary if current_summary else "No hay información previa."}

NUEVAS INTERACCIONES (Últimos 20 mensajes):
{chr(10).join(recent_interactions)}

INSTRUCCIONES:
1. Analiza las nuevas interacciones y combínalas con el resumen actual.
2. Genera un NUEVO RESUMEN DETALLADO Y EXTENSO.
3. No pierdas datos importantes anteriores (nombres, fechas, gustos, hechos clave).
4. Si hay información contradictoria, prioriza la más reciente pero anota la contradicción.
5. El tono del resumen debe ser técnico y analítico, enfocado en hechos y psicología del usuario.
6. Extrae: Nombre, Edad, Gustos, Disgustos, Estilo de habla, Relación con la IA, Datos curiosos.

SALIDA:
Devuelve SOLO el texto del nuevo resumen. No uses JSON ni markdown de código. Texto plano estructurado.
"""
        try:
            response = self.client.models.generate_content(
                model="gemini-2.5-flash",
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.3, # Baja temperatura para ser preciso y factual
                    top_p=0.95,
                    top_k=40
                )
            )
            return response.text.strip()
        except Exception as e:
            print(f"Error generando resumen de memoria: {e}")
            return current_summary

# Instancia global
brain = GeminiBrain()
