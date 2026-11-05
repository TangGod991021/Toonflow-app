# Docker 部署说明

[返回文档目录](./readme.md) · [返回项目首页](../README.md)

## 功能说明

使用 Docker / Docker Compose 在 Linux 容器中运行 Toonflow 服务端与 Web 页面。镜像基于 `oven/bun:1.4.3`（Debian 13 trixie），内置 FFmpeg，启动后通过 `http://127.0.0.1:3000` 访问。

为适配国内网络，构建阶段支持通过构建参数将 APT 与 npm 依赖源切换为镜像站，默认使用清华 Debian 镜像与 npmmirror。

## 涉及文件清单

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 定义镜像构建：安装 FFmpeg、安装依赖、编译服务端，并以非 root 用户 `bun` 启动 |
| `compose.yaml` | 定义服务、端口映射、数据卷与构建参数 |
| `.dockerignore` | 排除 `.git`、`node_modules`、`build`、`data`、环境变量文件与证书等无需进入构建上下文的内容 |

## 核心逻辑

### 构建参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `APT_MIRROR` | `mirrors.tuna.tsinghua.edu.cn` | 替换 `deb.debian.org` 的 APT 镜像域名；置空则使用官方源 |
| `NPM_REGISTRY` | `https://registry.npmmirror.com` | `bun install` 使用的 npm 源 |

两个参数在 `Dockerfile` 中通过 `ARG` 声明，并在 `compose.yaml` 的 `build.args` 中以 `${VAR:-默认值}` 形式暴露，可通过环境变量或项目根目录 `.env` 覆盖。

### 构建流程

1. 以 `oven/bun:1.4.3` 为基础镜像，切换 `WORKDIR /app`。
2. 将 `/etc/apt/sources.list.d/debian.sources` 中的 `deb.debian.org` 替换为 `APT_MIRROR`，安装 `ca-certificates` 与 `ffmpeg`。
3. 复制仓库内容后执行 `bun install --frozen-lockfile --registry="${NPM_REGISTRY}"`。
4. 执行 `bun run build:server` 生成 `build/server/index.js`，创建 `data/workspaces/myProject` 并将 `data` 归属调整为 `bun` 用户。
5. 设置 `NODE_ENV=production`、`TOONFLOW_DATA_DIR=/app/data`，以 `bun` 用户启动 `build/server/index.js`。

### 运行时约定

- 容器监听 `3000` 端口，`compose.yaml` 仅绑定宿主机 `127.0.0.1:3000`。
- 配置、插件与工作区保存在命名卷 `toonflowData`（实际名称带 Compose 项目前缀），挂载至容器 `/app/data`。
- 使用 `init: true` 处理 PID 1 信号，`restart: unless-stopped` 提供自动重启。

## 依赖关系

- 构建依赖：Docker Engine + Docker Compose v2（Windows/macOS 使用 Docker Desktop 的 Linux 容器模式）。
- 镜像构建依赖 `bun.lock` 与 `patchedDependencies`，修改依赖后需同步更新锁文件，否则 `--frozen-lockfile` 会失败。
- 业务依赖模型服务 API Key，需在页面内配置；Docker 不预置任何密钥。

## 使用方式

在仓库根目录执行：

```sh
# 构建并后台启动
docker compose up -d --build

# 查看日志
docker compose logs -f toonflow

# 停止 / 启动 / 删除容器（保留数据卷）
docker compose stop
docker compose start
docker compose down
```

自定义镜像源（示例）：

```sh
APT_MIRROR=mirrors.ustc.edu.cn \
NPM_REGISTRY=https://registry.npmmirror.com \
docker compose up -d --build
```

也可在项目根目录 `.env` 中写入同名变量，或直接修改 `compose.yaml` 的默认值。

> **注意**：不要执行 `docker compose down -v`，该命令会删除 `toonflowData` 数据卷。

## 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-03 | 新增 `APT_MIRROR`、`NPM_REGISTRY` 构建参数，默认使用国内镜像加速；补充本文档 |
