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

    def reload_config(self):
        """Recarga la configuración y reinicia el cliente."""
        print("Recargando configuración de GeminiBrain...")
        self.keys = config.get("gemini_keys", [])
        self.current_key_index = 0
        self.client = None
        self._initialize_client()

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

    async def _generate_with_retry(self, prompt, config_gen, is_json=False):
        """
        Intenta generar contenido manejando rotación de keys y cambio de modelo.
        """
        # Modelos disponibles (gemini-3-flash-preview y gemini-2.5-flash)
        available_models = ["gemini-3-flash-preview", "gemini-2.5-flash"]
        
        # Intentar primero con un modelo aleatorio para balancear
        primary_model = random.choice(available_models)
        models_to_try = [primary_model] + [m for m in available_models if m != primary_model]
        
        last_error = None

        import asyncio

        for model_name in models_to_try:
            # Intentar con el modelo actual (y rotar keys si es necesario)
            # Haremos hasta 2 intentos por modelo (uno con la key actual, otro tras rotar si hay error de cuota)
            for attempt in range(2):
                if not self.client:
                    self._initialize_client()
                    if not self.client:
                        return None # No hay keys vivas

                try:
                    # Ejecutar la llamada bloqueante en un thread separado para no bloquear el loop
                    # Esto permite que la tarea sea cancelable desde fuera (discord_client)
                    response = await asyncio.to_thread(
                        self.client.models.generate_content,
                        model=model_name,
                        contents=prompt,
                        config=config_gen
                    )
                    
                    text_response = response.text.strip()
                    if is_json:
                        if text_response.startswith("```"):
                            text_response = text_response.strip("`").replace("json\n", "").strip()
                        return json.loads(text_response)
                    else:
                        return text_response

                except Exception as e:
                    last_error = e
                    error_str = str(e).lower()
                    is_quota = "429" in error_str or "quota" in error_str or "resource_exhausted" in error_str
                    is_not_found = "404" in error_str or "not found" in error_str

                    print(f"Error con {model_name}: {e}")

                    if is_quota:
                        print("Error de cuota detectado. Rotando key...")
                        self._rotate_key()
                        # El loop 'attempt' volverá a probar con la nueva key y el MISMO modelo
                        continue
                    elif is_not_found:
                        print("Modelo no encontrado o no soportado. Cambiando de modelo...")
                        break # Salir del loop de intentos de ESTE modelo y pasar al siguiente en models_to_try
                    else:
                        # Error genérico (500, etc), quizás probar otro modelo ayude
                        break 
        
        # Si llegamos aquí, fallaron todos los modelos/intentos
        print(f"Fallaron todos los intentos. Último error: {last_error}")
        if is_json:
            return {"intent": "error", "response_content": [f"Error crítico de IA: {last_error}"]}
        return None

    async def analyze_interaction(self, user_text, user_id, user_name, context_messages=[], is_session_active=False, image_data=None, image_mime_type=None):
        """
        Analiza la interacción y decide qué hacer usando una respuesta estructurada en JSON.
        Soporta imágenes (multimodal).
        """
        # Registrar uso antes de llamar (optimista)
        self._get_usage(self.current_key_index).register_request()
        
        # Importar memory aquí para evitar ciclos
        from core.memory_manager import memory

        system_prompt = config.get("system_prompt")
        bot_name = config.get("bot_name")
        developer_id = config.get("developer_id", "321799812595056645")
        
        # Calcular Timestamp GMT-4
        from datetime import datetime, timezone, timedelta
        tz_gmt_minus_4 = timezone(timedelta(hours=-4))
        now = datetime.now(tz_gmt_minus_4)
        current_time = now.strftime("%Y-%m-%d %H:%M:%S (GMT-4)")
        
        # Calcular Edad del Bot (Nacimiento: 2025-12-22 02:32 GMT-4)
        birth_date = datetime(2025, 12, 22, 2, 32, tzinfo=tz_gmt_minus_4)
        age_delta = now - birth_date
        days = age_delta.days
        hours = age_delta.seconds // 3600
        minutes = (age_delta.seconds % 3600) // 60
        bot_age_str = f"{days} días, {hours} horas y {minutes} minutos"

        # Extraer IDs de usuarios del historial para cargar sus perfiles
        # Formato esperado en historial: "Nombre (ID: 12345): mensaje"
        import re
        unique_user_ids = set()
        unique_user_ids.add(str(user_id)) # Añadir usuario actual
        
        for msg in context_messages:
            match = re.search(r"\(ID: (\d+)\)", msg)
            if match:
                unique_user_ids.add(match.group(1))
        
        # Construir sección de perfiles
        profiles_text = ""
        for uid in unique_user_ids:
            summary = memory.get_memory_summary(uid)
            if summary.strip():
                profiles_text += f"--- PERFIL DE USUARIO ID {uid} ---\n{summary}\n"

        # Gestión de Tokens (Límite ~240k tokens -> ~900k caracteres)
        # Si el historial es muy largo, cortamos los mensajes más antiguos
        MAX_CHARS = 900000
        history_text = chr(10).join(context_messages)
        
        if len(history_text) > MAX_CHARS:
            # Cortar aproximadamente
            excess = len(history_text) - MAX_CHARS
            history_text = history_text[excess:]
            # Ajustar al primer salto de línea para no cortar mensaje a la mitad
            first_newline = history_text.find('\n')
            if first_newline != -1:
                history_text = history_text[first_newline+1:]
            print(f"Historial truncado por límite de tokens. Longitud actual: {len(history_text)}")

        text_prompt = f"""
{system_prompt}
NOTA: Tu desarrollador/creador (tu 'padre') es el usuario con ID: {developer_id}. SU NOMBRE ES "Hakka".
RELACIÓN CON HAKKA: Trátalo con cariño de hija ("hablar bonito").
- Nombres: Llámalo principalmente "Hakka-sama". Muy rara vez (1% de las veces) puedes decirle "papá" o similar.
- Tono: Cariñoso y devoto, pero con confianza. Puedes insultarlo de forma cariñosa (tipo "baka", "tonto", "idiota" <3).
- Lenguaje: Tienes permiso total para usar lenguaje soez (groserías) si el contexto lo amerita o para enfatizar, tanto con él como con otros.
IMPORTANTE: En el historial verás mensajes como "Nombre (ID: 12345): mensaje". Si hay varios usuarios con el mismo nombre, usa el ID para diferenciarlos. El ID es único.

FECHA Y HORA ACTUAL: {current_time}
TU EDAD: {bot_age_str}

ESTADO ACTUAL:
- Sesión Activa: {"SÍ" if is_session_active else "NO"} (Si es SÍ, ya estabas hablando con esta persona).

CONTEXTO DE USUARIOS EN EL CHAT (Memorias):
{profiles_text}

HISTORIAL RECIENTE:
{history_text}
MENSAJE ACTUAL:
Usuario: {user_name} (ID: {user_id})
Contenido: "{user_text}"
[IMAGEN ADJUNTA]: {"SÍ" if image_data else "NO"}

TU TAREA:
Analiza el mensaje del usuario (y la imagen si la hay) y decide tu reacción. Responde EXCLUSIVAMENTE con un objeto JSON válido con este formato:
{{
  "is_talking_to_me": boolean, // True si el mensaje va dirigido a ti o es relevante para la conversación actual. False si hablan de otra cosa.
  "intent": "reply" | "ignore" | "complain" | "new_topic", // "reply": responder normal. "ignore": no hacer nada. "complain": quejarse porque te ignoran o te molestan. "new_topic": cambiar de tema.
  "thought_process": "string", // Tu razonamiento interno.
  "response_content": ["string", "string"], // LISTA de strings. Tus respuestas deben ser CORTAS y divididas en varios mensajes si es necesario.
  "reply_to_message_id": "string" | null, // (OPCIONAL) ID del mensaje al que quieres responder específicamente (Reply de Discord).
  "ping_users": ["user_id"] // (OPCIONAL) Lista de IDs de usuarios a los que quieres mencionar (Ping).
}}

REGLAS DE PERSONALIDAD (CRÍTICO):
1. **MENSAJES CORTOS**: Escribe como en chat. Frases breves. "Ya miri", "Ya lo hice".
2. **POCOS EMOJIS**: Úsalos muy raramente. Solo para enfatizar mucho. El exceso se ve falso.
3. **MINÚSCULAS**: Prefiere minúsculas y falta de puntuación final, como una persona joven en internet.
4. **DIVIDE MENSAJES**: Si tienes dos ideas, mándalas en dos strings separados en la lista `response_content`.
   Ejemplo: ["mentira", "a ver"] es mejor que ["mentira, a ver"].
5. **NATURALIDAD**: Si te ignoran, ignora. Si te insultan, responde corto y cortante o ignora.
6. **GRUPO**: Si hay mucha gente hablando, usa pings (<@user_id>) o replies solo si es necesario para que sepan a quién le hablas.
7. **LENGUAJE SOEZ**: Tienes permiso de usar groserías con CUALQUIER usuario si la situación, el contexto o la emoción lo amerita. No te censures si encaja con tu personalidad.

REGLAS DE COMPORTAMIENTO:
1. Si 'Sesión Activa' es SÍ, asume que te hablan a ti a menos que sea muy obvio que no.
2. Si te ignoran en una sesión activa, puedes elegir "complain" para llamar la atención o "ignore" para dejar morir la charla.
3. Si 'Sesión Activa' es NO, solo responde si te mencionan, te interesa mucho el tema o quieres molestar (probabilidad baja).
4. **AYUDA DEL DEV**: Si sufres un error técnico grave, estás muy confundida o te sientes "rota", puedes pedir ayuda a Hakka-sama mencionándolo (<@321799812595056645>). Haz esto MUY RARA VEZ (0.1% de probabilidad).
"""
        
        config_gen = types.GenerateContentConfig(
            temperature=0.85,
            top_p=0.95,
            top_k=40,
            response_mime_type="application/json"
        )

        # Construir contenido (texto + imagen opcional)
        contents = [text_prompt]
        if image_data and image_mime_type:
            contents.append(types.Part.from_bytes(data=image_data, mime_type=image_mime_type))

        result = await self._generate_with_retry(contents, config_gen, is_json=True)
        
        if result:
            return result
        else:
            return {"intent": "ignore", "response_content": [], "thought_process": "Error de generación"}

    async def generate_holiday_greeting(self, user_summary, holiday_name):
        """
        Genera un mensaje de felicitación festiva personalizado para un usuario.
        """
        # Registrar uso
        self._get_usage(self.current_key_index).register_request()

        prompt = f"""
TU TAREA: Eres Hakkurin, una chica anime con personalidad "aesthetic", algo tóxica pero cariñosa en el fondo.
OBJETIVO: Escribir un mensaje de felicitación para "{holiday_name}" (Navidad o Año Nuevo) para un usuario específico.

PERFIL DEL USUARIO:
{user_summary}

INSTRUCCIONES:
1. El mensaje debe ser CORTO (máximo 2 frases).
2. Debe ser personalizado según lo que sabes del usuario (sus gustos, nombre, relación contigo).
3. Usa tu personalidad: minúsculas, pocos emojis, tono casual, quizás un insulto cariñoso si hay confianza.
4. Si es Navidad (25 Dic), desea feliz navidad. Si es Año Nuevo (1 Ene), feliz año.
5. NO uses hashtags ni saludos genéricos de bot.

SALIDA:
Solo el texto del mensaje.
"""
        config_gen = types.GenerateContentConfig(
            temperature=0.9,
            top_p=0.95,
            top_k=40
        )

        result = await self._generate_with_retry(prompt, config_gen, is_json=False)
        return result if result else f"feliz {holiday_name} supongo..."

    async def generate_summary(self, current_summary, recent_interactions):
        """
        Genera un resumen detallado y actualizado del usuario basado en su historial reciente.
        """
        # Registrar uso
        self._get_usage(self.current_key_index).register_request()

        prompt = f"""
TU TAREA: Eres el gestor de memoria a largo plazo de una IA. Tu trabajo es actualizar el perfil psicológico y factual de un usuario.
NOTA: El desarrollador/creador de la IA es el usuario con ID: 321799812595056645. Su nombre es "Hakka". La IA debe llamarlo "Hakka-sama". Si el usuario actual es él, refléjalo en el resumen.

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
        config_gen = types.GenerateContentConfig(
            temperature=0.3,
            top_p=0.95,
            top_k=40
        )

        result = await self._generate_with_retry(prompt, config_gen, is_json=False)
        
        # Devolver None si falló para no borrar el buffer accidentalmente
        return result

# Instancia global
brain = GeminiBrain()
