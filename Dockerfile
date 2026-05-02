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
    fd-find \
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-tlwg-loma-otf \
    fonts-unifont \
    fonts-wqy-zenhei \
    git \
    gosu \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libcairo2 \
    libcups2t64 \
    libdbus-1-3 \
    libdrm2 \
    libfontconfig1 \
    libfreetype6 \
    libgbm1 \
    libglib2.0-0t64 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    openssh-client \
    ripgrep \
    xfonts-scalable \
    xvfb \
  && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/bakery

COPY docker/entrypoint.sh /usr/local/bin/bakery-container-entrypoint
RUN chmod +x /usr/local/bin/bakery-container-entrypoint

ENV PI_WEB_CONTAINER_USER=bun \
  PI_WEB_CONTAINER_HOME=/home/bun \
  BUN_INSTALL=/home/bun/.bun

ENTRYPOINT ["/usr/local/bin/bakery-container-entrypoint"]
CMD ["bash", "-lc", "bun install && bun run dev:lan"]
