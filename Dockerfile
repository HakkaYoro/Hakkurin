# ---- build: compila TS + copia templates (nest-cli assets) a dist/ ----
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: sólo deps de producción + ffmpeg estático ----
# ponytail: ffmpeg estático de mwader/static-ffmpeg (~80MB) en vez del apt
# (~466MB de libs compartidas): misma decodificación https/webm-opus/m4a/mp3/flac
# y encoder libopus que usa ffmpeg.adapter.ts. Si algún día falta un codec
# exótico, upgrade path: volver a `apt-get install ffmpeg`.
FROM node:22-slim
WORKDIR /app
COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /usr/local/bin/ffmpeg
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

EXPOSE 8000
CMD ["node", "dist/main.js"]
