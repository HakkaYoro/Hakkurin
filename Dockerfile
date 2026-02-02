# Usar imagen base ligera de Python 3.11
FROM python:3.11-slim

# Evitar que Python genere archivos .pyc y buffer de salida
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Directorio de trabajo
WORKDIR /app

# Instalar dependencias del sistema necesarias (si las hubiera, por ahora git es útil)
RUN apt-get update && apt-get install -y git ffmpeg libsodium-dev && rm -rf /var/lib/apt/lists/*

# Copiar requirements e instalar dependencias
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copiar el código fuente
COPY . .

# Crear directorios para persistencia si no existen
RUN mkdir -p memory/users

# Exponer puerto de la WebUI
EXPOSE 8000

# Comando de inicio
CMD ["python", "main.py"]
