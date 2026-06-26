const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { DatabaseSync } = require("node:sqlite");

loadEnvFile();
clearDeadLocalProxy();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_BASE = process.env.VMODEL_API_BASE || "https://api.vmodel.ai/api/tasks/v1";
const CREATE_URL =
  process.env.VMODEL_SEEDREAM_CREATE_URL ||
  `${API_BASE}/bytedance/seedream-4-5/create`;
const TASK_GET_URL = process.env.VMODEL_TASK_GET_URL || `${API_BASE}/get`;
const VERSION_ID =
  process.env.VMODEL_SEEDREAM_VERSION ||
  "4ce713043ea0275271d7b65741005f5489b1218c4dfc012cc06763654a92a0aa";
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "xiaolin-wuyou.sqlite");

const db = initDatabase();

app.use(cors());
app.use(express.json({ limit: process.env.JSON_LIMIT || "120mb" }));
app.use((error, _req, res, next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({
      error: "请求体太大。请减少参考图数量，或压缩图片后重试。",
    });
  }
  next(error);
});
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(__dirname));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", (req, res) => {
  const configuredPublicBaseUrl = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  const requestBaseUrl = getRequestBaseUrl(req);
  const publicBaseUrl = isPublicHttpUrl(requestBaseUrl)
    ? requestBaseUrl
    : configuredPublicBaseUrl;
  res.json({
    ok: true,
    model: "bytedance/seedream-4.5",
    hasApiKey: false,
    publicBaseUrl,
    canUseLocalUploadForVmodel: isPublicHttpUrl(requestBaseUrl),
    acceptsDataUrlImageInput: false,
    hasTemporaryPublicUpload: true,
    hasDatabase: Boolean(db),
    version: VERSION_ID,
  });
});

app.post("/api/upload-local", requireAuth, (req, res) => {
  const { dataUrl, fileName } = req.body || {};
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(
    String(dataUrl || "")
  );

  if (!match) {
    return res.status(400).json({ error: "只支持 JPG、PNG、WEBP 图片。" });
  }

  const mimeType = match[1].toLowerCase();
  const base64 = match[2].replace(/\s/g, "");
  const buffer = Buffer.from(base64, "base64");

  if (!buffer.length || buffer.length > 10 * 1024 * 1024) {
    return res.status(400).json({ error: "图片大小必须在 10MB 以内。" });
  }

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const ext = mimeToExt(mimeType);
  const safeName = sanitizeFileName(fileName || `reference${ext}`);
  const storedName = `${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`;
  const diskPath = path.join(UPLOAD_DIR, storedName);
  fs.writeFileSync(diskPath, buffer);

  const localPath = `/uploads/${encodeURIComponent(storedName)}`;
  const requestBaseUrl = getRequestBaseUrl(req);
  const configuredPublicBaseUrl = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  const publicBaseUrl = isPublicHttpUrl(requestBaseUrl)
    ? requestBaseUrl
    : configuredPublicBaseUrl;
  const canUseForVmodel = isPublicHttpUrl(publicBaseUrl);
  const localReferenceUrl = canUseForVmodel ? `${publicBaseUrl}${localPath}` : "";

  if (localReferenceUrl) {
    return res.json({
      success: true,
      localPath,
      referenceUrl: localReferenceUrl,
      canUseForVmodel: true,
      source: "local-public-url",
      message: "本地图片已上传，并已生成 VModel 可访问的参考图 URL。",
    });
  }

  uploadToTemporaryPublicHost(buffer, storedName, mimeType)
    .then((referenceUrl) => {
      res.json({
        success: true,
        localPath,
        referenceUrl,
        canUseForVmodel: true,
        source: "temporary-public-upload",
        message: "本地图片已上传到临时公网图床，并已生成 VModel 可访问的参考图 URL。",
      });
    })
    .catch((error) => {
      res.status(502).json({
        error:
          error?.message ||
          "图片已保存到本地，但上传到临时公网图床失败。请稍后重试，或使用公网隧道/公网服务器。",
        localPath,
      });
    });
});

app.post("/api/create", requireAuth, async (req, res) => {
  const apiKey = getApiKey(req.body?.token);

  if (!apiKey) {
    return res.status(400).json({
      error: "请先在网页填写 VModel API Key。",
    });
  }

  let input;
  try {
    input = normalizeInput(req.body?.input);
    if (!input.prompt) {
      return res.status(400).json({ error: "缺少提示词 prompt。" });
    }
  } catch (error) {
    return res.status(400).json({ error: error.message || "请求参数错误。" });
  }

  const payload = {
    version: VERSION_ID,
    input,
  };

  try {
    console.log("创建任务请求", summarizePayload(payload));

    const response = await axios.post(CREATE_URL, payload, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 60000,
      proxy: false,
    });

    res.json(response.data);
  } catch (error) {
    handleProxyError(res, error, "创建任务失败");
  }
});

app.get("/api/status/:taskId", requireAuth, async (req, res) => {
  const taskId = String(req.params.taskId || "").trim();
  const apiKey = getApiKey(req.headers.authorization?.replace(/^Bearer\s+/i, ""));

  if (!apiKey) {
    return res.status(400).json({
      error: "请先在网页填写 VModel API Key。",
    });
  }

  if (!taskId) {
    return res.status(400).json({ error: "缺少 taskId。" });
  }

  try {
    const response = await axios.get(`${TASK_GET_URL}/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 30000,
      proxy: false,
    });

    res.json(response.data);
  } catch (error) {
    handleProxyError(res, error, "查询任务失败");
  }
});

app.get("/api/download-image", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const requestedName = sanitizeDownloadName(req.query.name || "");

  if (!isPublicHttpUrl(url)) {
    return res.status(400).json({ error: "缺少可下载的公网图片 URL。" });
  }

  try {
    const response = await axios.get(url, {
      responseType: "stream",
      timeout: 60000,
      proxy: false,
    });
    const contentType = response.headers["content-type"] || "image/png";
    const ext = contentType.includes("jpeg")
      ? "jpg"
      : contentType.includes("webp")
      ? "webp"
      : contentType.includes("png")
      ? "png"
      : "png";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${requestedName || `xiaolin-wuyou-${Date.now()}`}.${ext}"`);
    response.data.pipe(res);
  } catch (error) {
    handleProxyError(res, error, "下载图片失败");
  }
});

app.get("/api/admin/status", requireAuth, (_req, res) => {
  const uploadStats = getUploadStats();
  res.json({
    ok: true,
    port: PORT,
    model: "bytedance/seedream-4.5",
    hasApiKey: false,
    createUrl: CREATE_URL,
    taskGetUrl: TASK_GET_URL,
    uploadDir: UPLOAD_DIR,
    uploads: uploadStats,
    database: db ? { enabled: true, path: DB_PATH, states: getStateCount() } : { enabled: false },
    uptimeSeconds: Math.round(process.uptime()),
    memory: process.memoryUsage(),
  });
});

app.post("/api/admin/cleanup-uploads", requireAuth, (req, res) => {
  const maxAgeHours = clampNumber(req.body?.maxAgeHours, 1, 24 * 365, 24);
  const result = cleanupUploads(maxAgeHours);
  res.json({ ok: true, maxAgeHours, ...result });
});

app.get("/api/state", requireAuth, (req, res) => {
  const user = sanitizeStateUser(req.query.user);
  res.json({ ok: true, user, data: readState(user) });
});

app.post("/api/state", requireAuth, (req, res) => {
  const user = sanitizeStateUser(req.body?.user);
  const data = req.body?.data && typeof req.body.data === "object" ? req.body.data : {};
  saveState(user, data);
  res.json({ ok: true, user, savedAt: new Date().toISOString() });
});

app.post("/api/download-zip", requireAuth, async (req, res) => {
  const urls = Array.isArray(req.body?.urls)
    ? req.body.urls.map((url) => String(url || "").trim()).filter(isPublicHttpUrl).slice(0, 80)
    : [];
  const names = Array.isArray(req.body?.names) ? req.body.names : [];

  if (!urls.length) {
    return res.status(400).json({ error: "没有可打包下载的公网图片 URL。" });
  }

  const entries = [];
  const failures = [];
  const usedNames = new Set();

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    try {
      const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 60000,
        maxContentLength: 50 * 1024 * 1024,
        proxy: false,
      });
      const contentType = String(response.headers["content-type"] || "image/png");
      const fallbackName = `image-${String(index + 1).padStart(3, "0")}`;
      const baseName = sanitizeDownloadName(names[index] || fallbackName) || fallbackName;
      const ext = inferExt(contentType, url);
      const name = uniqueZipName(`${baseName}.${ext}`, usedNames);
      entries.push({ name, data: Buffer.from(response.data) });
    } catch (error) {
      failures.push(`${index + 1}. ${url} - ${error.message || "下载失败"}`);
    }
  }

  if (failures.length) {
    entries.push({
      name: "download-errors.txt",
      data: Buffer.from(failures.join("\r\n"), "utf8"),
    });
  }

  if (!entries.length) {
    return res.status(502).json({ error: "图片下载失败，未能生成 ZIP。" });
  }

  const zip = createZip(entries);
  const fileName = `xiaolin-wuyou-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(zip);
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Seedream 图生图工具运行在 http://localhost:${PORT}`);
  console.log("VModel API Key: 由访问者在网页填写");
});

function getApiKey(fallbackToken) {
  return String(fallbackToken || "").trim();
}

function normalizeInput(input = {}) {
  const result = {
    prompt: String(input.prompt || "").trim(),
  };

  if (Array.isArray(input.image_input) && input.image_input.length > 0) {
    const requestedUrls = input.image_input
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    const publicUrls = requestedUrls.filter(isPublicHttpUrl);

    if (!publicUrls.length) {
      throw new Error("VModel 图生图参考图必须是公网 HTTP/HTTPS 图片 URL。本地图片需要先上传转换成可访问 URL。");
    }

    if (publicUrls.length !== requestedUrls.length) {
      throw new Error("有参考图不是公网 HTTP/HTTPS 地址。VModel API 不接受 localhost、本地文件路径或 base64/data URL。");
    }

    result.size = ["1K", "2K", "4K"].includes(input.size) ? input.size : "2K";
    result.aspect_ratio = normalizeAspectRatio(input.aspect_ratio, "match_input_image");
    result.image_input = publicUrls.slice(0, 5);
    result.sequential_image_generation = "disabled";
    return result;
  }

  if (input.size === "custom") {
    result.width = clampNumber(input.width, 1024, 4096, 2048);
    result.height = clampNumber(input.height, 1024, 4096, 2048);
  } else {
    result.size = ["2K", "4K"].includes(input.size) ? input.size : "2K";
    result.aspect_ratio = normalizeAspectRatio(input.aspect_ratio, "1:1");
  }

  result.sequential_image_generation = "disabled";
  return result;
}

function isPublicHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.startsWith("10.") ||
      host.startsWith("192.168.")
    ) {
      return false;
    }
    const parts = host.split(".").map(Number);
    if (parts.length === 4 && parts.every((part) => Number.isInteger(part))) {
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeAspectRatio(value, fallback = "1:1") {
  const allowed = new Set([
    "match_input_image",
    "1:1",
    "16:9",
    "9:16",
    "4:3",
    "3:4",
    "3:2",
    "2:3",
    "21:9",
  ]);
  return allowed.has(value) ? value : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function requireAuth(_req, _res, next) {
  return next();
}

function initDatabase() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const database = new DatabaseSync(DB_PATH);
    database.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        user TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    return database;
  } catch (error) {
    console.error("初始化 SQLite 失败", error.message || error);
    return null;
  }
}

function sanitizeStateUser(value) {
  return String(value || "default").trim().replace(/[^\w.-]+/g, "-").slice(0, 80) || "default";
}

function readState(user) {
  if (!db) return {};
  const row = db.prepare("SELECT data FROM app_state WHERE user = ?").get(user);
  if (!row?.data) return {};
  try {
    return JSON.parse(row.data);
  } catch {
    return {};
  }
}

function saveState(user, data) {
  if (!db) return;
  db.prepare(`
    INSERT INTO app_state (user, data, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at
  `).run(user, JSON.stringify(data), new Date().toISOString());
}

function getStateCount() {
  if (!db) return 0;
  return db.prepare("SELECT COUNT(*) AS count FROM app_state").get()?.count || 0;
}

function inferExt(contentType, url) {
  if (contentType.includes("jpeg") || /\.jpe?g($|\?)/i.test(url)) return "jpg";
  if (contentType.includes("webp") || /\.webp($|\?)/i.test(url)) return "webp";
  if (contentType.includes("gif") || /\.gif($|\?)/i.test(url)) return "gif";
  if (contentType.includes("png") || /\.png($|\?)/i.test(url)) return "png";
  return "png";
}

function uniqueZipName(name, usedNames) {
  const parsed = path.parse(name);
  let candidate = name;
  let index = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${parsed.name}-${index}${parsed.ext}`;
    index += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || "");
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function handleProxyError(res, error, fallbackMessage) {
  const status = error.response?.status || 500;
  const data = error.response?.data;
  const message = {
    error: extractErrorMessage(data) || error.message || fallbackMessage,
    raw: data || null,
  };

  console.error(fallbackMessage, {
    status,
    data: typeof data === "string" ? data : JSON.stringify(data || message),
  });

  res.status(status).json(message);
}

function extractErrorMessage(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (typeof data.error === "string") return data.error;
  if (typeof data.detail === "string") return data.detail;
  if (typeof data.message === "string") return data.message;
  if (typeof data.message?.zh === "string") return data.message.zh;
  if (typeof data.message?.en === "string") return data.message.en;
  if (Array.isArray(data.errors) && data.errors.length) {
    return data.errors
      .map((item) => extractErrorMessage(item) || JSON.stringify(item))
      .filter(Boolean)
      .join("；");
  }
  if (typeof data.msg === "string") return data.msg;
  if (typeof data.code !== "undefined") return `VModel 返回错误：${JSON.stringify(data)}`;
  return "";
}

function summarizePayload(payload) {
  const input = { ...(payload.input || {}) };
  if (Array.isArray(input.image_input)) {
    input.image_input = input.image_input.map(summarizeImageInput);
    input.image_input_count = input.image_input.length;
  }
  return JSON.stringify({ ...payload, input }, null, 2);
}

function summarizeImageInput(item) {
  const value = String(item || "");
  const dataUrlMatch = /^data:(image\/[^;]+);base64,/i.exec(value);
  if (dataUrlMatch) {
    return `<data-url:${dataUrlMatch[1]};${value.length} chars>`;
  }
  if (value.length > 240) {
    return `${value.slice(0, 120)}...<${value.length} chars>`;
  }
  return value;
}

function getRequestBaseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0];
  const host = req.get("host");
  return host ? `${proto}://${host}`.replace(/\/+$/, "") : "";
}

function mimeToExt(mimeType) {
  if (mimeType.includes("png")) return ".png";
  if (mimeType.includes("webp")) return ".webp";
  return ".jpg";
}

function sanitizeFileName(fileName) {
  const parsed = path.parse(String(fileName || "reference.png"));
  const base = parsed.name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48) || "reference";
  const ext = parsed.ext.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 8) || ".png";
  return `${base}${ext}`;
}

function sanitizeDownloadName(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function getUploadStats() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    return { count: 0, bytes: 0, mb: 0, newest: null, oldest: null };
  }

  const files = fs.readdirSync(UPLOAD_DIR)
    .map((name) => {
      const filePath = path.join(UPLOAD_DIR, name);
      const stat = fs.statSync(filePath);
      return stat.isFile() ? { name, bytes: stat.size, mtimeMs: stat.mtimeMs } : null;
    })
    .filter(Boolean);
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const times = files.map((file) => file.mtimeMs);
  return {
    count: files.length,
    bytes,
    mb: Math.round((bytes / 1024 / 1024) * 100) / 100,
    newest: times.length ? new Date(Math.max(...times)).toISOString() : null,
    oldest: times.length ? new Date(Math.min(...times)).toISOString() : null,
  };
}

function cleanupUploads(maxAgeHours) {
  if (!fs.existsSync(UPLOAD_DIR)) return { deletedCount: 0, deletedBytes: 0 };
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let deletedCount = 0;
  let deletedBytes = 0;

  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    const filePath = path.join(UPLOAD_DIR, name);
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
    fs.unlinkSync(filePath);
    deletedCount += 1;
    deletedBytes += stat.size;
  }

  return {
    deletedCount,
    deletedBytes,
    deletedMb: Math.round((deletedBytes / 1024 / 1024) * 100) / 100,
    uploads: getUploadStats(),
  };
}

async function uploadToTemporaryPublicHost(buffer, fileName, mimeType) {
  const providers = [
    uploadToLitterbox,
    uploadToTmpFiles,
    uploadToUguu,
  ];

  const errors = [];
  for (const provider of providers) {
    try {
      const url = await provider(buffer, fileName, mimeType);
      if (isPublicHttpUrl(url)) return url;
      errors.push(`${provider.name}: did not return a public URL`);
    } catch (error) {
      errors.push(`${provider.name}: ${error.message || String(error)}`);
    }
  }

  throw new Error(`临时公网图床上传失败：${errors.join("；")}`);
}

async function uploadToLitterbox(buffer, fileName, mimeType) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("time", "1h");
  form.append("fileToUpload", new Blob([buffer], { type: mimeType }), fileName);

  const res = await fetchWithTimeout(
    "https://litterbox.catbox.moe/resources/internals/api.php",
    {
      method: "POST",
      body: form,
    }
  );

  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  if (!/^https?:\/\//i.test(text)) throw new Error(text || "invalid response");
  return text;
}

async function uploadToTmpFiles(buffer, fileName, mimeType) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), fileName);

  const res = await fetchWithTimeout("https://tmpfiles.org/api/v1/upload", {
    method: "POST",
    body: form,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);

  const pageUrl = data?.data?.url || data?.url || "";
  const directUrl = pageUrl.replace("https://tmpfiles.org/", "https://tmpfiles.org/dl/");
  if (!/^https?:\/\//i.test(directUrl)) throw new Error("invalid response");
  return directUrl;
}

async function uploadToUguu(buffer, fileName, mimeType) {
  const form = new FormData();
  form.append("files[]", new Blob([buffer], { type: mimeType }), fileName);

  const res = await fetchWithTimeout("https://uguu.se/upload.php", {
    method: "POST",
    body: form,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.description || data?.message || `HTTP ${res.status}`);

  const url = data?.files?.[0]?.url || data?.url || "";
  if (!/^https?:\/\//i.test(url)) throw new Error("invalid response");
  return url;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function clearDeadLocalProxy() {
  const deadProxy = /^https?:\/\/(?:127\.0\.0\.1|localhost):9\/?$/i;
  [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ].forEach((key) => {
    if (deadProxy.test(String(process.env[key] || ""))) {
      delete process.env[key];
    }
  });
}

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
