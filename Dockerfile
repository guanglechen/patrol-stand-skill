FROM node:22-bookworm-slim AS base

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

EXPOSE 8787
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATA_DIR=/app/data
ENV SANDBOX_MODE=docker
ENV SANDBOX_IMAGE=python:3.13-slim

CMD ["npm", "start"]
