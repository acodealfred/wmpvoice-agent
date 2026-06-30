# Stage 1: Build the Vite app
FROM node:20-slim AS build-stage
WORKDIR /frontend

# Install dependencies first so this layer is cached across deploys and only
# re-runs when package.json / package-lock.json change (not on every source edit).
COPY frontend/package*.json ./
RUN npm ci

# Then copy the rest of the frontend and build (node_modules is .dockerignored).
COPY frontend/ ./
RUN npm run build

# Stage 2: Serve the built app with a static file server
FROM python:3.12-slim AS production-stage

WORKDIR /app

# Litestream: streaming SQLite replication to Azure Blob (durable persistence
# across deployments). Pulled from the official image — single static binary,
# no extra OS packages needed. See docs/persistence.md for the rationale.
COPY --from=litestream/litestream:0.3.13 /usr/local/bin/litestream /usr/local/bin/litestream

COPY --from=build-stage /backend/static /app/static
COPY ./backend/ /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN python -m pip install -r requirements.txt

RUN python -m pip install gunicorn

RUN chmod +x /app/entrypoint.sh

# entrypoint restores the DB from blob, then launches the app under Litestream
# replication. With LITESTREAM_REPLICA_URL unset it just runs the app directly.
CMD ["/app/entrypoint.sh"]
