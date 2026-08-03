# ---- build: compila TS + copia templates (nest-cli assets) a dist/ ----
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: sólo deps de producción + ffmpeg (PCM para @discordjs/voice) ----
# ponytail: sin libsodium — el port usa node:crypto (AES-256-GCM) y @discordjs/voice
# trae su cifrado de voz en JS puro. Si voice fallara por encryption, añadir libsodium.
FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

EXPOSE 8000
CMD ["node", "dist/main.js"]
