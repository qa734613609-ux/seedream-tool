# 公网服务器部署

目标：让 VModel 能访问你上传的本地图片。部署后页面里选择本地图片，后端会保存到 `/uploads`，并生成 `https://你的域名/uploads/xxx.png` 传给 VModel。

## 服务器要求

- 一台公网服务器
- 一个域名，例如 `seedream.example.com`
- 域名 A 记录指向服务器公网 IP
- 已安装 Docker 和 Docker Compose

## 1. 上传项目

把 `seedream-tool` 整个目录上传到服务器，例如：

```bash
/opt/seedream-tool
```

不要上传你的本机 `node_modules`，服务器上会重新安装。

## 2. 配置环境变量

在服务器项目目录创建 `.env`：

```env
VMODEL_SEEDREAM_VERSION=4ce713043ea0275271d7b65741005f5489b1218c4dfc012cc06763654a92a0aa
PORT=3000
PUBLIC_BASE_URL=https://seedream.example.com
```

`PUBLIC_BASE_URL` 必须是公网 HTTPS 地址，不要写 `localhost`。
VModel API Key 不放在服务器环境变量里，访问者需要在网页中填写自己的 Key。

## 3. 启动服务

```bash
cd /opt/seedream-tool
docker compose up -d --build
```

检查状态：

```bash
docker compose ps
curl http://127.0.0.1:3000/api/health
```

## 4. Nginx 反向代理

安装 Nginx 后添加站点配置：

```nginx
server {
    server_name seedream.example.com;

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

启用配置并重载：

```bash
nginx -t
systemctl reload nginx
```

## 5. 配置 HTTPS

使用 Certbot：

```bash
certbot --nginx -d seedream.example.com
```

完成后访问：

```text
https://seedream.example.com
```

## 6. 使用

1. 打开 `https://seedream.example.com`
2. 选择本地图片
3. 页面会自动上传并填入参考图 URL
4. 输入提示词并生成

## 常见问题

- 如果页面提示 `VModel 不能访问 localhost`，说明你仍在用本机 `localhost` 访问，或者 `.env` 里的 `PUBLIC_BASE_URL` 没有设置成公网 HTTPS 地址。
- 如果图片上传后无法生成，先打开页面自动填入的 `/uploads/...` 图片链接，确认外网能访问。
- 修改 `.env` 后要重启：

```bash
docker compose restart
```
