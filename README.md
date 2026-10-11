# NEXUS STAGE · AI 视频制作工作台（本地）

连接 updream 的本地归档工作台：采集平台产出，按**人物三视图 / 场景白模+效果图 / 连续内容**三类归档，并提供可视化对照。

## 快速开始（新设备）

```bash
git clone git@github.com:danke92/updream-studio.git
cd updream-studio
start.bat          # Windows：自动建虚拟环境、装依赖、装 Chromium、打开浏览器
```

Linux / macOS：

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
python server.py 8788
```

然后浏览器打开 http://127.0.0.1:8788

## 目录结构

| 路径 | 说明 |
|---|---|
| `server.py` | 本地服务：静态托管 + 归档 REST API + 媒体流（纯标准库，无需 Flask） |
| `tools/collect_updream.py` | updream 采集器（Playwright 持久化登录态，命令队列避免线程绑定问题） |
| `web/` | 前端：原生 HTML/CSS/JS，无构建步骤 |
| `data/accounts.json` | 运行时生成，**不入库**：本机已登记账户索引（手机号 / 昵称 / 最近登录） |
| `data/accounts/u<手机号>/` | 每个号码的独立空间：`library.json`、`assets/`、`thumbs/`、`browser-profile/` |
| `start.bat` | 一键启动（含首次环境初始化） |

## 在其它设备上打开（同一 WiFi / 局域网）

服务默认监听 `0.0.0.0:8788`，所以同网络的手机、平板、另一台电脑也能访问：

```
http://<本机局域网 IP>:8788/
```

启动服务时控制台会直接打印这个地址（形如 `http://10.x.x.x:8788/`），也可以手动查：

```bash
ipconfig | findstr IPv4      # Windows
ip addr | grep inet          # Linux / macOS
```

**如果其它设备打不开**，多半是 Windows 防火墙拦截了入站连接 —— 在本机**双击 `allow-lan.bat`**（会弹 UAC，点「是」）即可放行 TCP 8788。

注意：局域网 IP 由路由器分配，可能会变；访问不了时重新看一眼控制台输出。

## 在任意网络下打开（公网网址 · 无需安装）

双击 `public-url.bat`，几秒后窗口里会出现一个 `https://xxxxxxxx.lhr.life` 的网址。
**任何设备、任何网络（4G / 5G / 别的 WiFi / 外地）直接打开即可，不用安装任何东西。**

原理：用 Windows 自带的 OpenSSH 建立一条到 `localhost.run` 的反向隧道，把本机 8788 端口映射到公网。
不需要下载软件、不需要改路由器、不需要公网 IP（运营商级 NAT 也能用）。

```
https://xxxxxxxx.lhr.life        ← 每次运行会变
```

限制：

- 运行隧道的那个黑色窗口**不能关**，关掉网址立刻失效。
- 这台电脑必须保持开机、且工作台（`start.bat`）在运行。
- 免费版域名随机，每次重启隧道地址会变；需要固定地址可在 [admin.localhost.run](https://admin.localhost.run/) 注册并绑定 SSH key。
- 网址是公开的，且默认处于**公用素材库模式**：任何拿到网址的人不用登录就能查看 / 上传 / 删除素材。介意的话请不要随意外发，或先在 `data/config.json` 里把 `publicMode` 改成 `false` 开启登录。

## 公用素材库模式（默认 · 无登录页）

默认就是**公用模式**：打开网址直接进入工作台，**没有登录页**，所有访问者共用同一个素材库
（顶栏显示「公用素材库」），共用库就是原来的「本机默认库」（号码 `000000`，历史资产都在里面）。

切换回「每人一个手机号、素材库互相隔离」的模式：编辑 `data/config.json`

```json
{ "publicMode": false, "publicName": "公用素材库" }
```

保存后重启服务即可，两种模式随时可来回切换，数据都不会丢。
临时切换也可以用环境变量：`NS_PUBLIC=0 ./.venv/Scripts/python.exe server.py`。

> 注意：公用模式下任何拿到网址的人都能查看、上传、删除素材。分享到公网前请确认能接受这一点。

### 可选：加一道访问口令

在 `data/config.json` 里加一行 `accessCode` 即可开启（**默认关闭，不填就完全没有输入界面**）：

```json
{ "publicMode": true, "publicName": "公用素材库", "accessCode": "18900843944" }
```

- 开启后每台设备**首次**打开会要求输入一次口令，通过后会记住**一年**（HttpOnly Cookie），之后直接进。
- 服务端存的是口令的哈希，重启服务后已通过的设备仍然有效，且无法从 Cookie 反推口令。
- `/api/*`、`/media`、`/file` 全部受保护；口令不对时静态页面也取不到任何素材数据。
- 想取消口令：把 `accessCode` 改回空字符串 `""` 并重启。

## 手机号登录 · 每个号码一套独立素材库（`publicMode: false`）

关闭公用模式后，首次打开会进入登录界面：**输入手机号即可进入**（无需密码、验证码）。

- 号码未登记过 → 自动创建一套全新的空素材库；可填昵称（选填）。
- 号码已登记过 → 直接进入该号码的素材库；登录界面下方会列出本机已有账户，点一下即可切换。
- 不同号码之间**完全隔离**：各自的 `library.json`、`assets/`、`thumbs/`、updream 浏览器登录态都在自己的目录下，互不可见、互不干扰。
- 顶栏右上角账户按钮：改昵称 / 退出并切换号码 / 销毁本账户素材库（二次确认，仅影响当前号码）。
- 旧版本（单库）数据在首次启动时会自动迁入「**本机默认库**」（号码 `000000`），历史资产不会丢。

## 使用

1. **登录 updream**：工作台 → 接入产出 → updream 采集 → 启动浏览器，**由你本人**完成登录（工作台不接触密码）。登录态保存在本账户的 `browser-profile/`，下次免登录。
2. **采集**：在浏览器里打开项目画布，回工作台点「采集当前页」，图片/视频自动下载并按文件名关键词归类。
3. **归档视图**：人物对照墙 / 场景对照（白模↔效果图滑块）/ 连续内容 / 全部资产。
4. **修正归类**：点开卡片 → 抽屉里改类型、角色、视角、标签 → 保存。UUID 命名的图无法自动识别，需手动归类。
5. **其他接入方式**：文件上传、手动登记、本地目录扫描（只索引不复制）。

## 主要接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/auth/me` | 当前登录账户 + 本机账户列表 |
| GET | `/api/auth/check?phone=` | 号码是否已登记（用于登录页实时提示） |
| POST | `/api/auth/login` | 手机号登录（不存在则自动创建），下发会话 Cookie |
| GET | `/api/auth/logout` | 退出当前账户 |
| POST | `/api/auth/rename` | 修改昵称 |
| POST | `/api/auth/delete` | 销毁当前账户及其全部素材 |
| GET | `/api/library` | 全量归档 + 分组 + 统计（需登录） |
| POST | `/api/upload` | 上传文件 |
| POST | `/api/scan` | 扫描本地目录 |
| POST | `/api/assets/<id>/update` | 修改条目 |
| POST | `/api/assets/<id>/delete` | 删除条目 |
| POST | `/api/collect/start` | 启动采集浏览器（登录） |
| POST | `/api/collect/goto` | 跳转到指定项目 |
| POST | `/api/collect/capture` | 采集当前页 |
| GET | `/media/<file>` | 媒体流（支持 Range） |

## 注意

- 归档数据与登录态只存在本地，不随仓库分发；换设备需重新采集（或自行拷贝 `data/`）。
- 采集只读取页面上已加载的媒体，不做任何登录凭据的读写。
