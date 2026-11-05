FROM oven/bun:1.4.3

WORKDIR /app

# ACT: 国内网络环境可通过构建参数切换到镜像源，留空则使用官方源。
ARG APT_MIRROR=mirrors.tuna.tsinghua.edu.cn
ARG NPM_REGISTRY=https://registry.npmmirror.com

# ACT: 版本号在构建时写入服务端产物（官方 release 由 CI 传入 appVersion）。
ARG APP_VERSION=2.0.9
ENV appVersion=${APP_VERSION}

RUN if [ -n "${APT_MIRROR}" ]; then \
        sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY . .

# ACT: 保留工作区与依赖以兼容运行时动态加载；需要缩减镜像时再拆分构建阶段。
RUN bun install --frozen-lockfile --registry="${NPM_REGISTRY}"

RUN bun run build:server \
    && mkdir -p data/workspaces/myProject \
    && chown -R bun:bun data

ENV NODE_ENV=production
ENV TOONFLOW_DATA_DIR=/app/data

USER bun
EXPOSE 3000

CMD ["bun", "build/server/index.js"]
