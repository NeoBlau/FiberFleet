FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY client/package*.json client/
RUN npm --prefix client ci
COPY client client
RUN npm --prefix client run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 FF_DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev
COPY server server
COPY --from=build /app/client/dist client/dist
VOLUME /data
EXPOSE 8080
CMD ["node", "server/index.js"]
