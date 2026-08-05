FROM mcr.microsoft.com/devcontainers/base:ubuntu

# PostgreSQL server + client, baked in so the postgres test path (test/config.json → 127.0.0.1:5432)
# works locally without a separate service. The Bun runtime is provided by the devcontainer feature.
RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends postgresql postgresql-contrib \
    && rm -rf /var/lib/apt/lists/*
