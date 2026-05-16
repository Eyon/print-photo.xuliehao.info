# wechat-photo-print-app

公众号照片原图上传与照片打印队列专用应用。当前推荐部署方式是 Docker，不依赖 Cloudflare Worker 或 R2。

## 功能

- 公众号网页前端：微信内优先使用微信 JS-SDK 原图模式选图和上传；非微信环境保留普通文件上传，方便调试。
- Node/Express 后端：生成 JS-SDK 签名、从微信临时素材接口拉取图片、保存图片到服务器磁盘，用户确认后再创建打印任务。
- 打印队列 API：按 `storeId` 区分不同门店/地点，预留给后续 Windows Python 打印脚本轮询和回写状态。

持久化目录：

- `/data/uploads`：用户上传的图片，只保留 30 分钟。
- `/data/temp-uploads`：待确认上传的临时记录。
- `/data/jobs`：打印任务状态 JSON。
- `/data/queue/pending/<storeId>`：各门店待打印队列。
- `/data/wechat`：微信 `access_token` 和 `jsapi_ticket` 缓存。
- `/downloads`：公开下载文件目录，映射到网页路径 `/download/`。

## Docker 部署

在海外服务器上安装 Docker 和 Docker Compose，然后上传这个项目目录。

复制环境变量模板：

```sh
cp .env.example .env
```

编辑 `.env`：

```ini
WECHAT_APP_ID=你的公众号AppID
WECHAT_APP_SECRET=你的公众号AppSecret
PRINTER_AGENT_TOKEN=随便生成一段长随机字符串
MAX_UPLOAD_BYTES=52428800
DOWNLOAD_DIR=/downloads
UPLOAD_TTL_MS=1800000
PORT=3230
HOST_PORT=3231
```

启动：

```sh
docker compose up -d --build
```

查看日志：

```sh
docker compose logs -f
```

容器内默认监听 `3230`，宿主机默认映射到 `3231`，避免和原项目冲突。生产环境建议在前面放 Nginx/Caddy，提供 HTTPS 和域名，例如：

```text
https://photo-print.example.com -> http://127.0.0.1:3231
```

## 微信原图模式

这个专用版不做门店白名单判断，微信内默认全部尽量走原图模式：

- 优先调用 `wx.chooseMedia`，参数包含 `mediaType: ['image']` 和 `sizeType: ['original']`。
- 如果当前微信环境不支持 `chooseMedia`，或无法继续上传，会回退到 `wx.chooseImage`，但仍然只传 `sizeType: ['original']`。
- 上传仍走微信链路：`wx.uploadImage -> /api/wechat/media-import`，不改成浏览器原生文件上传。

注意：`sizeType: ['original']` 表示请求微信选择原图版本，但图片仍经过微信临时素材链路，不能保证完全等同于浏览器原始文件。

## 公开下载目录

Docker 部署时，项目目录里的 `downloads/` 会挂载到容器内的 `/downloads`，并通过 `/download/` 对外提供静态文件。

在 VPS 的项目目录里创建目录并放文件：

```sh
mkdir -p downloads
cp xxx.zip downloads/
docker compose up -d --build
```

然后就可以访问：

```text
https://print.xuliehao.info/download/xxx.zip
```

注意：`/download/` 是公开目录，放进去的文件只要知道链接就能访问。文件名建议只用英文字母、数字、横线、下划线和点，例如 `printer-agent-v1.zip`。

## 微信公众号后台配置

在微信公众号后台配置：

- 「基本配置」里的 IP 白名单：填写这台海外服务器的公网出口 IP。
- 「公众号设置」或「功能设置」里的 JS 接口安全域名：填写你的正式域名，例如 `print.example.com`，不要带 `https://` 和路径。
- 当前页面没有做用户身份授权，所以网页授权域名暂时不是必须项。

本地 `localhost` 不能通过微信 JS-SDK 域名校验。代码里已经处理为：本地环境直接走普通网页上传。

## API

上传网页通过 URL 参数选择门店：

```text
https://print.example.com/?storeId=home
https://print.example.com/?storeId=store1
https://print.example.com/?storeId=store2
```

不传 `storeId` 时默认是 `home`。`storeId` 会被规范化为小写字母、数字、`-` 和 `_`，最多 64 个字符。

前端使用：

- `GET /api/wechat/js-config?url=...` 获取微信 JS-SDK 签名。
- `POST /api/wechat/media-import` 用微信 `serverId/media_id` 拉取图片并创建临时上传，JSON body 里包含 `storeId`。
- `POST /api/uploads` 普通网页文件上传兜底，multipart form 里包含 `storeId`，创建临时上传。
- `GET /api/uploads/:uploadId/image` 预览临时上传图片。
- `POST /api/uploads/:uploadId/print` 用户确认后创建打印任务。
- `GET /api/jobs/:jobId` 查询任务状态。

后续 Windows Python 打印脚本使用：

- `GET /api/print/next?storeId=home` 领取 `home` 的待打印任务。
- `GET /api/print/next?storeId=store1` 领取 `store1` 的待打印任务。
- `GET /api/print/jobs/:jobId/image` 下载任务图片。
- `POST /api/print/jobs/:jobId/status` 回写 `printed` 或 `failed`。

这些打印接口需要：

```http
Authorization: Bearer <PRINTER_AGENT_TOKEN>
```

Windows 照片打印 Agent 单独放在打印机电脑上运行；只需要把它的 `server_url` 指向这个专用服务，并使用同一个 `PRINTER_AGENT_TOKEN`。

## 本地开发

安装依赖：

```sh
npm install
```

构建 Docker 版应用：

```sh
npm run build
```

启动构建后的 Node 服务：

```sh
DATA_DIR=./data PORT=3000 npm run start
```

前端开发服务器仍可使用：

```sh
npm run dev
```
