# 免费部署到 Render

这条路线不需要买域名和服务器。Render 会给你一个固定免费网址，例如：

```text
https://seedream-tool.onrender.com
```

限制：

- 免费实例资源较小，空闲后可能休眠，第一次打开会慢。
- 免费实例的本地磁盘不适合长期保存重要上传文件和 SQLite 数据。
- 适合先让别人用固定网址访问；如果要稳定商用，仍建议买服务器和域名。

## 1. 准备 GitHub 仓库

把当前项目上传到 GitHub。不要上传 `.env`、`node_modules/`、`uploads/`、`data/`。

项目已经包含 `render.yaml`，Render 可以自动识别部署配置。

## 2. 创建 Render 服务

1. 打开 https://render.com
2. 注册或登录
3. 选择 `New` -> `Blueprint`
4. 连接你的 GitHub 仓库
5. Render 会读取 `render.yaml`
6. 部署

## 3. 访问

部署完成后，Render 会显示一个免费固定网址：

```text
https://你的服务名.onrender.com
```

打开这个网址后，访问者需要在网页里填写自己的 VModel API Key，保存后即可使用。

## 4. 本地图上传说明

部署在 Render 后，页面会自动使用当前 `https://*.onrender.com` 作为公网地址，
上传的参考图会生成公网 URL 给 VModel 读取。

如果以后绑定自己的域名，再把环境变量改成：

```env
PUBLIC_BASE_URL=https://你的域名
```
