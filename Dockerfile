FROM node:24-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3230
ENV DATA_DIR=/data
ENV DOWNLOAD_DIR=/downloads
ENV CLIENT_DIR=/app/dist/client

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

RUN mkdir -p /data /downloads && chown -R node:node /data /downloads /app

USER node

EXPOSE 3230

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3230/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
