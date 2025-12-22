# 🌸 Hakkurin - Advanced AI Discord Bot

[![GitHub](https://img.shields.io/badge/GitHub-HakkaYoro-pink?style=flat-square&logo=github)](https://github.com/HakkaYoro)
[![Python](https://img.shields.io/badge/Python-3.9%2B-blue?style=flat-square&logo=python)](https://www.python.org/)
[![Gemini](https://img.shields.io/badge/AI-Gemini%202.5%20Flash-orange?style=flat-square&logo=google)](https://deepmind.google/technologies/gemini/)

[Español](#descripción-del-proyecto) | [English](#project-description)

---

## 🇪🇸 Descripción del Proyecto

**Hakkurin** no es solo otro bot de Discord. Es una entidad de IA avanzada diseñada para simular una personalidad humana compleja (E-girl/Otaku/Fujoshi) con una capacidad de conversación natural y memoria a largo plazo.

A diferencia de los bots tradicionales que responden a comandos, Hakkurin "vive" en tu servidor. Escucha, decide cuándo participar, recuerda quién eres y puede ignorarte si no le caes bien.

### ✨ Características Principales

*   **🧠 Cerebro Avanzado (Gemini 2.5 Flash)**: Utiliza la última tecnología de Google para generar respuestas creativas, sarcásticas y contextuales.
*   **💾 Memoria Encriptada**: Cada usuario tiene su propia base de datos de memoria segura. Hakkurin recuerda tu nombre, tus gustos y conversaciones pasadas.
*   **🗣️ Motor de Conversación Inteligente**:
    *   **Análisis de Intención**: Decide si responder, ignorar, quejarse o cambiar de tema basándose en el contexto.
    *   **Gestión de Sesiones**: Mantiene el hilo de la conversación. Si le dejas de hablar, puede que se despida o se moleste.
*   **⚙️ WebUI de Configuración**: Panel de control moderno y "aesthetic" para ajustar su personalidad, API keys y comportamiento en tiempo real.
*   **🎲 Interacción Probabilística**: Puede unirse a conversaciones aleatorias si le parece interesante (configurable).

---

## 🚀 Instalación y Uso

### Prerrequisitos
*   **Python 3.9** o superior.
*   Una cuenta de **Discord Developer** (para el Token del bot).
*   Una o más API Keys de **Google AI Studio** (Gemini).

### 🖥️ Windows

1.  **Clonar el repositorio**:
    Abre PowerShell o CMD y ejecuta:
    ```bash
    git clone https://github.com/HakkaYoro/Hakkurin.git
    cd Hakkurin
    ```

2.  **Instalar dependencias**:
    ```bash
    pip install -r requirements.txt
    ```

3.  **Iniciar Hakkurin**:
    ```bash
    python main.py
    ```

4.  **Configuración**:
    *   Al iniciar, verás un mensaje indicando que la WebUI está lista.
    *   Abre tu navegador y ve a `http://localhost:8000`.
    *   Ingresa tu **Bot Token** y tus **Gemini API Keys**.
    *   ¡Guarda y listo! (Es recomendable reiniciar el script `main.py` tras poner el Token por primera vez).

### 🐧 Linux (Ubuntu/Debian)

1.  **Preparar el entorno**:
    ```bash
    sudo apt update && sudo apt install python3 python3-pip git -y
    ```

2.  **Clonar e Instalar**:
    ```bash
    git clone https://github.com/HakkaYoro/Hakkurin.git
    cd Hakkurin
    pip3 install -r requirements.txt
    ```

3.  **Ejecutar**:
    ```bash
    python3 main.py
    ```
    Sigue los mismos pasos de configuración en la WebUI (`http://localhost:8000`).

### 🐳 Docker (Próximamente)

*El soporte oficial para Docker y Docker Compose está en desarrollo.*

Si deseas ejecutarlo en un contenedor manualmente por ahora:
1.  Asegúrate de tener el puerto `8000` expuesto para la WebUI.
2.  Monta el volumen `/memory` para no perder los datos de los usuarios.

---

## 🛠️ Configuración Avanzada

Todo se maneja desde la **WebUI**. No necesitas tocar archivos de código.

*   **System Prompt**: Define la personalidad de Hakkurin. ¡Sé creativo!
*   **Reply Probability**: Probabilidad (0.0 a 1.0) de que responda a mensajes donde no la mencionan.
*   **Allowed Channels**: IDs de los canales donde permites que hable (deja vacío para todos).

---

<br>

## 🇺🇸 Project Description

**Hakkurin** is not just another Discord bot. It is an advanced AI entity designed to simulate a complex human personality (E-girl/Otaku/Fujoshi) with natural conversational capabilities and long-term memory.

Unlike traditional bots that respond to commands, Hakkurin "lives" in your server. She listens, decides when to participate, remembers who you are, and might ignore you if she doesn't like you.

### ✨ Key Features

*   **🧠 Advanced Brain (Gemini 2.5 Flash)**: Uses Google's latest tech to generate creative, sarcastic, and contextual responses.
*   **💾 Encrypted Memory**: Each user has their own secure memory database. Hakkurin remembers your name, likes, and past conversations.
*   **🗣️ Smart Conversation Engine**:
    *   **Intent Analysis**: Decides whether to reply, ignore, complain, or change the topic based on context.
    *   **Session Management**: Keeps track of the conversation thread. If you stop talking, she might say goodbye or get annoyed.
*   **⚙️ Configuration WebUI**: Modern, "aesthetic" dashboard to adjust personality, API keys, and behavior in real-time.
*   **🎲 Probabilistic Interaction**: She can randomly join conversations if she finds them interesting.

---

## 🚀 Installation & Usage

### Prerequisites
*   **Python 3.9** or higher.
*   A **Discord Developer** account (for the Bot Token).
*   One or more **Google AI Studio** API Keys (Gemini).

### 🖥️ Windows

1.  **Clone the repository**:
    Open PowerShell or CMD and run:
    ```bash
    git clone https://github.com/HakkaYoro/Hakkurin.git
    cd Hakkurin
    ```

2.  **Install dependencies**:
    ```bash
    pip install -r requirements.txt
    ```

3.  **Start Hakkurin**:
    ```bash
    python main.py
    ```

4.  **Configuration**:
    *   Upon starting, you'll see a message that the WebUI is ready.
    *   Open your browser and go to `http://localhost:8000`.
    *   Enter your **Bot Token** and **Gemini API Keys**.
    *   Save and you're set! (Restarting `main.py` is recommended after setting the Token for the first time).

### 🐧 Linux (Ubuntu/Debian)

1.  **Prepare environment**:
    ```bash
    sudo apt update && sudo apt install python3 python3-pip git -y
    ```

2.  **Clone and Install**:
    ```bash
    git clone https://github.com/HakkaYoro/Hakkurin.git
    cd Hakkurin
    pip3 install -r requirements.txt
    ```

3.  **Run**:
    ```bash
    python3 main.py
    ```
    Follow the same configuration steps in the WebUI (`http://localhost:8000`).

### 🐳 Docker (Coming Soon)

*Official support for Docker and Docker Compose is currently in development.*

If you wish to run it manually in a container for now:
1.  Ensure port `8000` is exposed for the WebUI.
2.  Mount the `/memory` volume to persist user data.

---

## 🛠️ Advanced Configuration

Everything is managed via the **WebUI**. No need to touch code files.

*   **System Prompt**: Define Hakkurin's personality. Be creative!
*   **Reply Probability**: Probability (0.0 to 1.0) of her replying to messages where she isn't mentioned.
*   **Allowed Channels**: IDs of channels where she is allowed to speak (leave empty for all).

---

Made with 💖 by [HakkaYoro](https://github.com/HakkaYoro)
