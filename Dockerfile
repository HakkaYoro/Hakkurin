# ---- build: compila TS + copia templates (nest-cli assets) a dist/ ----
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: sólo deps de producción + ffmpeg (PCM para @discordjs/voice) ----
# ponytail: libsodium-wrappers (WASM) + opusscript (JS puro) — sin compilación
# nativa, funciona en node:22-slim sin build-essential. Upgrade path: si el
# rendimiento importa, cambiar a sodium-native + @discordjs/opus (requiere
# build-essential y python3 en ambos stages o copiar node_modules del build).
FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

EXPOSE 8000
CMD ["node", "dist/main.js"]
