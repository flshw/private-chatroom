# Private Chatroom（私密聊天）

房间级端到端加密聊天。独立仓库、独立进程、独立数据目录；与主线 ChatRoom 共用 `flshw.online:443`，通过 `/Pchat/`、`/pc/api/*`、`/pc/ws` 前缀隔离。

> 安全声明：服务端只持有公钥、签名、密文与必要的房间元数据，不具备解密聊天内容的能力。文件即准入凭证，请仅通过可信渠道分发专属 HTML；详细边界见 [`docs/19-私密聊天-安全边界说明.md`](docs/19-私密聊天-安全边界说明.md)。

## 当前状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 独立骨架、PC 协议常量、单文件模板构建 | 完成 |
| M2 | 账号、会话、自动通过、签发/重签、吊销/销毁、TTL 清理 | 完成 |
| M3 | 配置验签、成员公钥三重验证、双层加密文字往返 | 完成 |
| M4 | 文件、语音、WebRTC 信令代码 | 已实现，待跨浏览器联调 |
| M5 | `/Pchat/` 云端反代接入、生命周期验收 | 待接入 |

本地验证结果（2026-11-16）：

- `node tools/verify-pc-crypto.js`：**27 / 27 通过**
- `node tools/smoke-pc.js`：**27 / 27 通过**

## 目录结构

```text
shared/protocol.js               PC 协议常量、canonicalJSON、signedPart（唯一真源）
vendor/forge.min.js              浏览器端 RSA-PSS / RSA-OAEP / AES-GCM
vendor/sql-wasm.wasm             sql.js 运行时
server/src/                      控制面、数据面、数据库、密钥库、签发器
server/public/index.html         建房门户（注册/登录/申请/下载）
server/admin/index.html          运维总览（管理员令牌保护）
client/src/                      单文件客户端源码
client/dist/private-chat.template.html  构建产物，保留 __PC_CONFIG__ 占位符
tools/build-client.js            构建单文件模板
tools/verify-pc-crypto.js        加密互通专项测试
tools/smoke-pc.js                端到端冒烟测试
docs/17-私密聊天-需求分析报告.md
docs/18-私密聊天-设计方案.md
docs/19-私密聊天-安全边界说明.md
```

## 本地运行

需要 Node.js 22+。

```bash
# 1. 安装服务端依赖
cd server
npm install
cd ..

# 2. 构建单文件客户端模板（会同步 server/src/protocol.js）
node tools/build-client.js

# 3. 启动独立服务，默认监听 127.0.0.1:8443
node server/src/main.js
```

打开 `http://127.0.0.1:8443/Pchat/` 注册并创建房间。下载得到的 HTML 即为该房间的专属客户端，发给朋友后双击打开，填昵称即可入房。

`/Pchat/p/:roomId` 在线地址在 v0.1 只显示使用提示，不通过网址传递 `joinToken`，避免凭证进入浏览器历史、Referer 或访问日志。

冒烟测试：

```bash
# 服务运行时，在另一个终端执行
node tools/smoke-pc.js

# 自定义地址
CHATROOM_PC_BASE=http://127.0.0.1:8443 node tools/smoke-pc.js
```

加密互通专项测试不依赖服务：

```bash
node tools/verify-pc-crypto.js
```

## 配置项

所有配置均通过环境变量传入：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PC_PORT` | `8443` | 独立进程监听端口 |
| `PC_HOST` | `127.0.0.1` | 监听地址，生产应由反代暴露 |
| `PC_PUBLIC_PREFIX` | `/Pchat` | 门户与在线入口前缀 |
| `PC_API_PREFIX` | `/pc/api` | 控制面接口前缀 |
| `PC_WS_PATH` | `/pc/ws` | WebSocket 数据面路径 |
| `PC_SERVER_URL` | `https://flshw.online` | 写入客户端配置块的公网地址 |
| `PC_DATA_DIR` | `server/data` | 数据库、密钥、文件、日志根目录 |
| `PC_KEYS_DIR` | `$PC_DATA_DIR/keys` | SSK / RK 私钥目录 |
| `PC_LOG_DIR` | `$PC_DATA_DIR/logs` | 运行日志目录 |
| `PC_ADMIN_TOKEN` | 空 | 运维强制销毁接口令牌，生产必须设置 |
| `PC_TLS_CERT` / `PC_TLS_KEY` | 空 | 进程直出 HTTPS 时可选；反代终止 TLS 时留空 |
| `PC_QUOTA_ROOMS` | `3` | 每人同时活跃房间数 |
| `PC_HARD_MAX_MEMBERS` | `20` | 单房人数硬上限 |

## 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/pc/api/health` | 版本、房间数、连接数、待清理数 |
| POST | `/pc/api/auth/register` | 注册账号 |
| POST | `/pc/api/auth/login` | 登录并设置 HttpOnly `pc_sid` Cookie |
| POST | `/pc/api/auth/logout` | 登出 |
| GET | `/pc/api/rooms` | 我的房间列表 |
| POST | `/pc/api/rooms/apply` | 创建房间并下载专属 HTML |
| GET | `/pc/api/rooms/:id/client` | 重新签发：轮换 joinToken 与 RK，踢出旧连接 |
| POST | `/pc/api/rooms/:id/revoke` | 吊销房间 |
| POST | `/pc/api/rooms/:id/dissolve` | 房主销毁房间 |
| GET | `/pc/api/room/:id/status` | 客户端启动校时与状态检查 |
| POST | `/pc/api/file/upload` | 上传客户端已加密的文件密文 |
| GET | `/pc/api/file/get` | 下载文件密文 |
| GET | `/Pchat/admin/` | 运维总览，需 `X-PC-ADMIN-Token` |

WebSocket 路径为 `/pc/ws`。所有业务消息在客户端完成加密/签名，服务端只做验签、密文转发与完整性检查。

## 加密模型摘要

- `SSK`：平台签名密钥，签发客户端配置块；公钥内置并参与验签。
- `RK_i`：每房签名密钥，签发成员公钥清单；重新签发/销毁时立即删除私钥。
- `UK_i`：成员本地密钥对，私钥永不上传。
- 每条消息随机生成 `K_msg`，用 AES-256-GCM 加密内容，再按每个成员公钥用 RSA-OAEP 单独封装。
- 成员清单由 `RK_pub` 验签，且每条公钥带成员 `selfSig`，`version` 必须严格递增。
- 服务端保存的只有密文、公钥、签名、HMAC 摘要与元数据。

## 部署注意

- `server/data/` 含签名私钥与数据库，目录权限建议 `0700`，不得提交或公开下载。
- 生产环境必须设置 `PC_ADMIN_TOKEN`；否则运维销毁接口始终拒绝访问。
- 若由主线 Nginx / Node 反代接入，需要把 `/Pchat/`、`/pc/api/*`、`/pc/ws` 全部转发到本进程，并保持 Upgrade 头。
- 当前版本尚未完成云端 `/Pchat/` 反代正式接入；主线上 `/Pchat/` 仍是占位入口。

## 许可

Copyright (c) 2026 CJS flshw@126.com。仅限本 Private Chatroom 分发使用。
