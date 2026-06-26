# 永久网站部署

真正永久的网址需要一个固定域名，例如 `image.example.com`。临时的
`*.trycloudflare.com` 只能测试使用，重启后可能变化。

## 推荐方案：服务器 + 域名

准备：

- 一台公网服务器
- 一个域名，并把域名 A 记录指向服务器公网 IP
- 服务器安装 Docker 和 Docker Compose

服务器 `.env` 示例：

```env
VMODEL_SEEDREAM_VERSION=4ce713043ea0275271d7b65741005f5489b1218c4dfc012cc06763654a92a0aa
PORT=3000
PUBLIC_BASE_URL=https://image.example.com
```

VModel API Key 不放在服务器上。访问者打开网页后，需要填写自己的 Key 才能生图。

启动服务：

```bash
docker compose up -d --build
curl http://127.0.0.1:3000/api/health
```

Nginx 反向代理：

```nginx
server {
    server_name image.example.com;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

配置 HTTPS：

```bash
certbot --nginx -d image.example.com
```

完成后访问：

```text
https://image.example.com
```

## 备选方案：固定域名指向本机

如果不买服务器，也可以用 Cloudflare 账号创建 named tunnel，把自己的域名固定转发到本机
`http://localhost:3000`。这种方式的域名可以固定，但你的电脑必须一直开机，网络也要稳定。

基本流程：

```powershell
cloudflared tunnel login
cloudflared tunnel create seedream-tool
cloudflared tunnel route dns seedream-tool image.example.com
```

创建 Cloudflare 配置文件，例如：

```yaml
tunnel: seedream-tool
credentials-file: C:\Users\你的用户名\.cloudflared\seedream-tool.json

ingress:
  - hostname: image.example.com
    service: http://localhost:3000
  - service: http_status:404
```

启动：

```powershell
cloudflared tunnel run seedream-tool
```

同时把本项目 `.env` 里的地址改成：

```env
PUBLIC_BASE_URL=https://image.example.com
```

然后重启 `node server.js`。

## 重要

- `PUBLIC_BASE_URL` 必须是公网 HTTPS 地址，不能是 `localhost`。
- 对外开放后，访问者必须填写自己的 VModel API Key；服务器不会使用共享 Key。
- `uploads/` 和 `data/` 都需要持久化；当前 `docker-compose.yml` 已经挂载这两个目录。
