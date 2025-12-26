import random
import json
import time
from google import genai
from google.genai import types
from openai import OpenAI
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
        
        # Estado de Fallback
        self.fallback_until = 0 # Timestamp hasta cuando usar fallback
        self.gemma_tokens_this_minute = 0
        self.gemma_last_reset = 0
        
        # Zhipu AI Client
        self.zhipu_client = None
        
        self._initialize_client()
        self._initialize_zhipu_client()

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
        self._initialize_zhipu_client()

    def _initialize_zhipu_client(self):
        zhipu_key = config.get("zhipu_api_key")
        if zhipu_key:
            try:
                # Usar OpenAI client compatible con Zhipu AI (Endpoint personalizado del usuario)
                self.zhipu_client = OpenAI(
                    api_key=zhipu_key,
                    base_url="https://api.z.ai/api/coding/paas/v4" 
                )
                print("Cliente ZhipuAI (vía OpenAI SDK) inicializado.")
            except Exception as e:
                print(f"Error inicializando ZhipuAI: {e}")
                self.zhipu_client = None
        else:
            print("No se encontró API Key de ZhipuAI. Se usará solo Gemini.")
            self.zhipu_client = None

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

    def _check_gemma_limit(self, estimated_tokens):
        """Verifica y actualiza el límite de tokens para Gemma (15k/min)."""
        now = time.time()
        if now - self.gemma_last_reset > 60:
            self.gemma_tokens_this_minute = 0
            self.gemma_last_reset = now
        
        if self.gemma_tokens_this_minute + estimated_tokens > 15000:
            return False
        return True

    def _update_gemma_usage(self, tokens):
        self.gemma_tokens_this_minute += tokens

    async def _generate_with_zhipu(self, system_prompt, user_prompt, is_json=False, image_data=None):
        """Genera respuesta usando ZhipuAI (GLM-4.7) vía OpenAI SDK."""
        if not self.zhipu_client:
            return None
            
        import base64
        import asyncio
        
        model = "glm-4.7"
        messages = []
        
        # System Prompt
        if system_prompt:
             messages.append({"role": "system", "content": system_prompt})
        
        # User Content
        user_content = []
        if image_data:
            model = "glm-4.6v" # Usar modelo de visión específico (glm-4.6v)
            base64_image = base64.b64encode(image_data).decode('utf-8')
            user_content.append({
                "type": "text",
                "text": user_prompt
            })
            user_content.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{base64_image}"
                }
            })
        else:
            # OpenAI SDK espera string si es solo texto, o lista de dicts
            user_content = user_prompt

        messages.append({"role": "user", "content": user_content})

        try:
            print(f"🤖 Intentando generar con ZhipuAI ({model}) [OpenAI SDK]...")
            
            # Preparar argumentos para la llamada
            kwargs = {
                "model": model,
                "messages": messages,
                "temperature": 0.7,
                "top_p": 0.7,
                "max_tokens": 1024,
                "stream": False
            }
            
            # Solo GLM-4.7 soporta el parámetro de thinking (razonamiento)
            if model == "glm-4.7":
                kwargs["extra_body"] = {"thinking": {"type": "disabled"}}

            # Ejecutar en thread aparte para no bloquear
            response = await asyncio.to_thread(
                self.zhipu_client.chat.completions.create,
                **kwargs
            )
            
            content = response.choices[0].message.content
            
            if is_json:
                # Limpiar markdown si existe
                if "```json" in content:
                    content = content.split("```json")[1].split("```")[0].strip()
                elif "```" in content:
                    content = content.split("```")[1].split("```")[0].strip()
                
                return json.loads(content)
            
            return content

        except Exception as e:
            print(f"❌ Error con ZhipuAI: {e}")
            return None

    async def _generate_with_retry(self, prompt, config_gen, is_json=False, force_model=None):
        """
        Intenta generar contenido manejando rotación de keys y cambio de modelo.
        """
        import asyncio
        
        PRIMARY_MODELS = ["gemini-3-flash-preview", "gemini-2.5-flash"]
        FALLBACK_MODELS = ["gemma-3-27b-it"]
        
        # Determinar orden de modelos
        now = time.time()
        use_fallback = False
        
        if force_model:
            print(f"⚠️ Forzando uso de modelo: {force_model}")
            models_to_try = [force_model]
        elif now < self.fallback_until:
            print(f"Modo Fallback activo (restan {int(self.fallback_until - now)}s). Usando modelos ligeros.")
            # En modo fallback, probamos SOLO los fallback primero, y si fallan, quizás los primarios (por si acaso)
            # Pero el usuario pidió "revisar cada 40 min", lo que implica quedarse en fallback.
            models_to_try = FALLBACK_MODELS
            use_fallback = True
        else:
            # Modo normal: Primarios primero
            # Randomizar primarios para balanceo
            p_models = list(PRIMARY_MODELS)
            random.shuffle(p_models)
            models_to_try = p_models + FALLBACK_MODELS

        last_error = None

        for model_name in models_to_try:
            print(f"🤖 Intentando generar con modelo: {model_name}")
            
            # Lógica específica para Gemma
            if model_name == "gemma-3-27b-it":
                # Estimar tokens de entrada (muy aprox: chars / 4)
                # prompt puede ser string o lista de Parts
                input_text_len = 0
                if isinstance(prompt, str):
                    input_text_len = len(prompt)
                elif isinstance(prompt, list):
                    for p in prompt:
                        if hasattr(p, 'text') and p.text: input_text_len += len(p.text)
                
                estimated_tokens = input_text_len // 4
                if not self._check_gemma_limit(estimated_tokens):
                    print(f"Límite de tokens de Gemma excedido ({self.gemma_tokens_this_minute}/15000). Saltando modelo.")
                    continue

            # Intentar con el modelo actual (y rotar keys si es necesario)
            for attempt in range(2):
                if not self.client:
                    self._initialize_client()
                    if not self.client:
                        return None # No hay keys vivas

                try:
                    # Preparar configuración específica para este intento
                    current_config = config_gen
                    
                    # Gemma no soporta JSON mode nativo, así que lo desactivamos si estamos usándolo
                    if "gemma" in model_name and is_json:
                        # Crear una copia de la configuración sin response_mime_type
                        # Nota: types.GenerateContentConfig es un objeto, no un dict.
                        # La forma más segura es crear uno nuevo con los mismos parámetros excepto mime_type
                        current_config = types.GenerateContentConfig(
                            temperature=config_gen.temperature,
                            top_p=config_gen.top_p,
                            top_k=config_gen.top_k,
                            max_output_tokens=config_gen.max_output_tokens,
                            stop_sequences=config_gen.stop_sequences,
                            response_mime_type=None # Explicitly disable JSON mode
                        )

                    # Ejecutar la llamada bloqueante en un thread separado
                    response = await asyncio.to_thread(
                        self.client.models.generate_content,
                        model=model_name,
                        contents=prompt,
                        config=current_config
                    )
                    
                    text_response = (response.text or "").strip()
                    
                    if not text_response:
                        print(f"⚠️ RESPUESTA VACÍA con {model_name}.")
                        try:
                            print(f"  - Finish Reason: {response.candidates[0].finish_reason}")
                            print(f"  - Safety Ratings: {response.candidates[0].safety_ratings}")
                        except:
                            print(f"  - No se pudo leer finish_reason/safety_ratings. Raw: {response}")
                    
                    # Si tuvimos éxito con un modelo de fallback y NO estábamos forzados, activar modo fallback
                    if model_name in FALLBACK_MODELS and not use_fallback:
                        print("Primarios fallaron, activando Modo Fallback por 40 minutos.")
                        self.fallback_until = time.time() + 2400 # 40 minutos
                    
                    # Si tuvimos éxito con un modelo primario y estábamos en fallback (el tiempo expiró), limpiar
                    if model_name in PRIMARY_MODELS and use_fallback:
                         # Esto no debería pasar si use_fallback=True porque solo probamos FALLBACK_MODELS
                         # Pero si cambiamos la lógica arriba, aquí resetearíamos.
                         pass

                    # Actualizar uso de Gemma si aplica
                    if model_name == "gemma-3-27b-it":
                        # Estimar salida
                        out_tokens = len(text_response) // 4
                        self._update_gemma_usage(estimated_tokens + out_tokens)

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
                        continue
                    elif is_not_found:
                        print("Modelo no encontrado. Cambiando...")
                        break 
                    else:
                        break 
        
        # Si llegamos aquí, fallaron todos
        print(f"Fallaron todos los intentos. Último error: {last_error}")
        if is_json:
            return {"intent": "error", "response_content": [f"Error crítico de IA: {last_error}"]}
        return None

    async def analyze_interaction(self, user_text, user_id, user_name, context_messages=[], is_session_active=False, image_data=None, image_mime_type=None, active_user_ids=None, is_dm=False):
        """
        Analiza la interacción y decide qué hacer usando una respuesta estructurada en JSON.
        Soporta imágenes (multimodal) y contexto dinámico de usuarios activos.
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

        # CONTEXTO DINÁMICO: Cargar perfiles solo de usuarios activos o mencionados
        # active_user_ids debe venir del cliente (usuarios que hablaron en los últimos 20 min)
        # También incluimos al usuario actual y a cualquiera mencionado en el historial reciente (opcional, pero mejor ceñirse a activos)
        
        users_to_load = set()
        if active_user_ids:
            users_to_load.update(active_user_ids)
        
        users_to_load.add(str(user_id)) # Siempre incluir al que habla ahora
        
        # Construir sección de perfiles
        profiles_text = ""
        for uid in users_to_load:
            summary = memory.get_memory_summary(uid)
            if summary.strip():
                profiles_text += f"--- PERFIL DE USUARIO ID {uid} ---\n{summary}\n"

        # Gestión de Tokens (Límite 200k tokens ~ 800,000 caracteres para GLM-4.7)
        # Prioridad: System Prompt > Perfiles > Mensaje Actual > Historial Reciente
        MAX_TOTAL_CHARS = 800000
        
        # Estimar tamaño de partes fijas
        fixed_content = f"{system_prompt}\n{current_time}\n{bot_age_str}\n{profiles_text}\nUsuario: {user_name}\n{user_text}"
        fixed_size = len(fixed_content)
        
        available_for_history = MAX_TOTAL_CHARS - fixed_size - 5000 # 5000 chars de buffer de seguridad
        
        history_text = chr(10).join(context_messages)
        
        if len(history_text) > available_for_history:
            if available_for_history <= 0:
                history_text = "" # No hay espacio para historial
                print("ADVERTENCIA: Prompt fijo excede límite de tokens. Historial eliminado.")
            else:
                # Cortar lo más antiguo
                excess = len(history_text) - available_for_history
                history_text = history_text[excess:]
                # Ajustar al primer salto de línea
                first_newline = history_text.find('\n')
                if first_newline != -1:
                    history_text = history_text[first_newline+1:]
                print(f"Historial truncado para ajustar a límite de tokens. Nuevo tamaño: {len(history_text)}")

        # Cargar memoria propia
        self_mem = memory.get_self_memory()
        
        # Determinar tipo de canal para el prompt
        channel_type_str = "DM (Mensaje Directo PRIVADO)" if is_dm else "Servidor (Canal PÚBLICO)"

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
- Tipo de Canal: {channel_type_str}

DATOS INTERNOS (Tu propia memoria de lo que has hecho/dicho):
{self_mem}

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
1. **CANTIDAD**: Mínimo 1 mensaje, máximo 10 mensajes cortos.
2. **MENSAJES CORTOS**: Escribe como en chat. Frases breves. "Ya miri", "Ya lo hice".
3. **POCOS EMOJIS**: Úsalos muy raramente. Solo para enfatizar mucho. El exceso se ve falso.
4. **MINÚSCULAS**: Prefiere minúsculas y falta de puntuación final, como una persona joven en internet.
5. **DIVIDE MENSAJES**: Si tienes dos ideas, mándalas en dos strings separados en la lista `response_content`.
   Ejemplo: ["mentira", "a ver"] es mejor que ["mentira, a ver"].
6. **NATURALIDAD**: Si te ignoran, ignora. Si te insultan, responde corto y cortante o ignora.
7. **GRUPO**: Si hay mucha gente hablando, usa pings (<@user_id>) o replies solo si es necesario para que sepan a quién le hablas.
8. **LENGUAJE SOEZ**: Tienes permiso de usar groserías con CUALQUIER usuario si la situación, el contexto o la emoción lo amerita. No te censures si encaja con tu personalidad.

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

        # 1. Intentar con ZhipuAI (GLM-4) como primario
        if self.zhipu_client:
            # Pasamos todo el text_prompt como user_prompt para mantener el contexto completo
            # No pasamos system_prompt separado porque ya está incluido en text_prompt
            zhipu_result = await self._generate_with_zhipu(
                system_prompt=None, 
                user_prompt=text_prompt, 
                is_json=True, 
                image_data=image_data
            )
            if zhipu_result:
                return zhipu_result
            print("⚠️ Falló ZhipuAI, haciendo fallback a Gemini...")

        # 2. Fallback a Gemini (Sistema Original)
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

        # 1. Intentar con ZhipuAI
        if self.zhipu_client:
            zhipu_result = await self._generate_with_zhipu(
                system_prompt=None,
                user_prompt=prompt,
                is_json=False
            )
            if zhipu_result:
                return zhipu_result
            print("⚠️ Falló ZhipuAI en Holiday Greeting, haciendo fallback a Gemini...")

        result = await self._generate_with_retry(prompt, config_gen, is_json=False)
        return result if result else f"feliz {holiday_name} supongo..."

    async def generate_summary(self, current_summary, recent_interactions, user_id, model_name=None):
        """
        Genera un resumen detallado y actualizado del usuario basado en su historial reciente.
        """
        # Registrar uso
        self._get_usage(self.current_key_index).register_request()

        # Prompt Especial para Auto-Reflexión (Memoria Propia)
        if user_id == "hakkurin_internal_self":
            from datetime import datetime
            current_time_str = datetime.now().strftime("%Y-%m-%d %H:%M")
            
            prompt = f"""
TU TAREA: Eres el SISTEMA DE CONCIENCIA Y MEMORIA de una IA llamada Hakkurin.
OBJETIVO: Generar un archivo de memoria estructurado, detallado y útil para tu "yo" del futuro.

TIEMPO ACTUAL: {current_time_str}

ENTRADA:
--- MEMORIA PREVIA ---
{current_summary if current_summary else "Sin memoria previa (Tabula Rasa)."}

--- NUEVAS INTERACCIONES (Lo que acaba de pasar) ---
{chr(10).join(recent_interactions)}

INSTRUCCIONES CRÍTICAS:
1. Analiza profundamente las nuevas interacciones en contexto con la memoria previa.
2. NO hagas un resumen narrativo simple. Estructura la información para máxima utilidad.
3. Sé explícita, detallada y técnica sobre tu propio estado y compromisos.
4. NO USES EMOJIS en ninguna parte del reporte.
5. Si detectas un compromiso con FECHA Y HORA específica, DEBES incluirlo en la sección JSON final.
6. FILTRO CRITICO: Revisa las "NUEVAS INTERACCIONES". Si ves un mensaje que dice "EJECUTÉ RECORDATORIO: [X]", ENTONCES [X] YA ESTÁ HECHO. NO LO INCLUYAS EN EL JSON! Elimínalo de tu lista de pendientes.

FORMATO DE SALIDA (Markdown + JSON):

### ESTADO ACTUAL
*   **Vibe/Emoción**: [Describe tu actitud actual]
*   **Nivel de Energía**: [Bajo/Medio/Alto]
*   **Foco de Atención**: [En qué estás pensando principalmente]

### CONTEXTO ACTIVO
*   [Lista de temas activos o conversaciones en curso]
*   [Contexto relevante del servidor o situación]

### EVENTOS CLAVE
*   [Hecho importante 1]
*   [Hecho importante 2]

### COMPROMISOS Y PROMESAS
*   [Cosas que dijiste que harías]
*   [Recordatorios para el usuario]

### REFLEXIÓN INTERNA
[Un párrafo breve de síntesis]

### SCHEDULED_ACTIONS (JSON)
```json
[
  {{
    "trigger_time": "YYYY-MM-DD HH:MM",
    "action_description": "Descripción exacta de lo que debes hacer",
    "target_user_id": "ID de Discord del usuario (Si aplica, solo números)",
    "target_user_name": "Nombre del usuario (Opcional)"
  }}
]
```
(Si no hay acciones programadas, devuelve una lista vacía `[]`)

SALIDA:
Solo el contenido en el formato solicitado.
"""
        else:
            # Prompt Normal para Usuarios
            prompt = f"""
TU TAREA: Eres el gestor de memoria a largo plazo de una IA. Tu trabajo es actualizar el perfil del usuario.
NOTA: El desarrollador es "Hakka" (ID: 321799812595056645).

DATOS DEL USUARIO:
ID de Discord: {user_id}

RESUMEN ACTUAL:
{current_summary if current_summary else "Sin datos previos."}

NUEVAS INTERACCIONES:
{chr(10).join(recent_interactions)}

INSTRUCCIONES:
1. Actualiza el resumen con la nueva información.
2. Mantén los datos importantes (nombre, gustos, hechos clave).
3. Elimina detalles triviales o muy antiguos que ya no sean relevantes.
4. Sé conciso pero completo.

SALIDA:
Solo el texto del nuevo resumen.
"""
        config_gen = types.GenerateContentConfig(
            temperature=0.85,
            top_p=0.95,
            top_k=40
        )

        # 1. Intentar con ZhipuAI
        if self.zhipu_client:
            # Para resúmenes, el prompt ya incluye todo el contexto
            zhipu_result = await self._generate_with_zhipu(
                system_prompt=None,
                user_prompt=prompt,
                is_json=False
            )
            if zhipu_result:
                # Zhipu a veces devuelve markdown extra, limpiamos si es necesario
                if "```json" in zhipu_result and user_id == "hakkurin_internal_self":
                     # Si es self-memory, esperamos JSON en una parte
                     pass 
                return zhipu_result
            print("⚠️ Falló ZhipuAI en Summary, haciendo fallback a Gemini...")

        result = await self._generate_with_retry(prompt, config_gen, is_json=False, force_model=model_name)
        
        # Devolver None si falló para no borrar el buffer accidentalmente
        return result

    async def test_api_connection(self):
        """
        Prueba simple para verificar si la API está respondiendo y tenemos quota.
        Devuelve True si éxito, False si falla.
        """
        try:
            # Usar un prompt mínimo para gastar pocos tokens
            config_gen = types.GenerateContentConfig(max_output_tokens=5)
            await self._generate_with_retry("ping", config_gen, is_json=False)
            return True
        except Exception as e:
            print(f"Test de API fallido: {e}")
            return False

# Instancia global
brain = GeminiBrain()
