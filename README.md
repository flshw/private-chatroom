# Private Chatroom（私密聊天）

房间级端到端加密聊天。独立仓库、独立进程、独立数据目录；与主线 ChatRoom 共用 `flshw.online:443`，通过 `/Pchat/`、`/pc/api/*`、`/pc/ws` 前缀隔离。

> 安全声明：服务端只持有公钥、签名、密文与必要的房间元数据，不具备解密聊天内容的能力。文件即准入凭证，请仅通过可信渠道分发专属 HTML；详细边界见 [`docs/19-私密聊天-安全边界说明.md`](docs/19-私密聊天-安全边界说明.md)。

## 当前状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 独立骨架、PC 协议常量、单文件模板构建 | 完成 |
| M2 | 账号、会话、自动通过、签发/重签、吊销/销毁、TTL 清理 | 完成 |
| M3 | 配置验签、成员公钥三重验证、双层加密文字往返 | 完成 |
| M4 | 文件、语音、WebRTC 信令、全双工语音 | 完成 |
| M5 | `/Pchat/` 云端反代接入、生命周期验收 | 完成 |
| M6 | 双版本客户端（简洁版 / 豪华版）、掼蛋联机、单人旁观锁定 | 完成 |
| M7 | 扫码分享（简洁版/豪华版双二维码，在线直达）、手牌同类堆叠与自动理牌 | 完成 |

客户端提供两个版本，均保持单文件、无外部资源、离线可运行：

- **简洁版**（默认）：文字、文件、语音条、视频通话，轻量快速。
- **豪华版**：在简洁版基础上增加轻量 Canvas 3D 牌桌场景、全双工语音、可拖拽画中画视频小窗，以及端到端加密的**四人联机掼蛋**（含逢人配/进贡/升级规则），并支持**一对一旁观**：每人只能旁观一名指定的玩家，选定后锁定不可更改、不能旁观其他人，且**必须经被旁观者同意**才能看到其手牌；掉线重连仍识别为同一旁观关系。
  - 输入昵称后直接进入房间；F5 刷新使用本机已有密钥与昵称自动续进，不会退回登录页。密钥以纯 PEM 字符串存于 `localStorage`（`file://` 下可靠，规避 IndexedDB 挂起与密钥对象无法克隆的问题）；房间到期/销毁或点击「退出」时本地凭证自动清除。
  - 顶部栏提供「退出」按钮：确认后清除本机昵称/密钥/消息、断开连接并返回登录页，之后刷新不会再自动进入。
  - 掼蛋按钮在房间达到 4 人时才可点击；点击弹出选人窗口，房间恰好 4 人时自动全选另外三人，超过 4 人时随机预选三人（均可点击调整），开局后窗口立即关闭，所有客户端按同一座次发牌。
  - **单人测试机器人**：房间仅有一名真人时自动补入 3 个本地机器人凑齐 4 席，可立即开局测试掼蛋；第二位真人进入后机器人全部退出、把座位让给真人。机器人手牌仅存于房主本机、经自动理牌（去单化/保炸弹/顺子连对三带二优先，策略参考公开掼蛋组牌原则），出牌由房主经 E2EE 通道广播，服务端只见密文。
  - 掼蛋面板顶部内置记牌器，按两副牌（普通点数各 8 张、大小王各 2 张）实时扣减已出牌与本人可见手牌。
  - **手牌自动堆叠 + 一键理牌**：发到的手牌按掼蛋理牌习惯自动归类——同点数牌叠成一摞并显示 `×N` 角标（点堆叠整组选中/取消，便于出对子、三张、炸弹），炸弹/王/大牌在前、同类从大到小；「自动理牌」按钮可随时重新归类，「↔ 平铺」可在堆叠与逐张显示间切换。

**扫码分享（在线直达）**：建房成功或在「我的房间」点「二维码」，门户会生成简洁版与豪华版两个二维码。用手机相机/微信扫码后在浏览器打开即进入同一房间（填昵称即可），无需下载 HTML 文件。两个二维码共用房间凭证、可多人同时使用；重新下载客户端、重新签发或销毁房间后旧二维码立即失效。二维码内容是一个高熵 bearer 分享码（`server/public` 仅存其 SHA-256 摘要与缓存 HTML），等价于把客户端文件发给对方，请勿随意公开转发。

建房或在「我的房间」下载时可选择版本；下载会重新签发（轮换 joinToken 与房间签名密钥），旧客户端与旧二维码立即失效。公开房间目录只展示房间名、状态、剩余时间与在线人数，不泄露准入凭证。

本地验证结果（2026-11-16）：

- `node tools/test-guandan.js`：**45 / 45 通过**（掼蛋牌型/逢人配/进贡还贡抗贡/升级规则）
- `node tools/test-bots.js`：**9 / 9 通过**（理牌合法性/去单化/出牌决策/四机器人自对战分出胜负，20 次连跑稳定）
- `node tools/verify-pc-crypto.js`：**61 / 61 通过**（含双版本模块完整性、localStorage 刷新续进、退出按钮、机器人补位与手牌本地性、四人选座弹窗、记牌器、按会话校验 seq 与旁观模型回归断言）
- `node tools/smoke-pc.js`：**41 / 41 通过**（含双版本下载、一对一旁观同意流程、公开目录、房主自行销毁）
- `node tools/test-shares.js`：**17 / 17 通过**（隔离实例：建房→双版二维码→扫码返回内联 HTML→两版共享同一 joinToken→重签轮换旧码失效→销毁失效并清理缓存）
- 真实浏览器验证：简洁版/豪华版入房、3D 场景渲染、单人机器人补位与选座开局、机器人自动出牌闭环、手牌同类堆叠/整组选牌/一键理牌/平铺切换、门户二维码渲染均通过，无运行时异常。
- 修复：消息 seq 由「房间全局递增」改为「每个发送会话递增」，多人同时发言/发游戏帧不再误报 `E_REPLAY`。

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
