# syntax=docker/dockerfile:1

FROM oven/bun:1

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    docker-cli \
    docker.io \
    git \
    gosu \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/bakery

COPY docker/entrypoint.sh /usr/local/bin/bakery-container-entrypoint
RUN chmod +x /usr/local/bin/bakery-container-entrypoint

ENV PI_WEB_CONTAINER_USER=bun \
  PI_WEB_CONTAINER_HOME=/home/bun \
  BUN_INSTALL=/home/bun/.bun

ENTRYPOINT ["/usr/local/bin/bakery-container-entrypoint"]
CMD ["bash", "-lc", "bun install && bun run dev:lan"]
