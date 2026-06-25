# 没有公网服务器时的用法

用 Cloudflare Quick Tunnel 可以把本机 `http://localhost:3000` 临时变成公网 HTTPS 地址，例如：

```text
https://abc-def-123.trycloudflare.com
```

VModel 就能通过这个地址访问你上传到本机的图片。

## 1. 安装 cloudflared

用 Windows 终端运行：

```cmd
winget install --id Cloudflare.cloudflared
```

安装后关闭并重新打开终端，确认：

```cmd
cloudflared --version
```

## 2. 启动网页服务

双击：

```text
start-server.cmd
```

保持窗口打开。

## 3. 启动公网隧道

再双击：

```text
start-tunnel.cmd
```

保持窗口打开。窗口里会出现类似：

```text
https://xxxx.trycloudflare.com
```

脚本会自动把这个地址写入 `.env`：

```env
PUBLIC_BASE_URL=https://xxxx.trycloudflare.com
```

## 4. 重启网页服务

关闭并重新运行：

```text
start-server.cmd
```

## 5. 使用

浏览器打开 Cloudflare 给你的地址：

```text
https://xxxx.trycloudflare.com
```

不要再用 `http://localhost:3000` 打开。这样你上传的本地图片会生成公网 URL，VModel 才能读取。

## 注意

- Quick Tunnel 地址通常每次重启都会变化。
- 地址变化后，`start-tunnel.cmd` 会自动更新 `.env` 里的 `PUBLIC_BASE_URL`，但你仍要重启 `start-server.cmd`。
- `start-server.cmd` 和 `start-tunnel.cmd` 两个窗口都要保持打开。
