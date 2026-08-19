const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// 允许网站域名和本地开发访问
app.use(cors({ origin: ["https://haorui.xyz", "http://localhost:3000"] }));
app.use(express.json({ limit: "10mb" }));

// ========== 数据存储层 ==========
// 优先使用 Vercel KV（Redis），Vercel 部署时数据持久化；
// 未配置 KV 环境变量时降级到本地文件（仅本地开发可用）。

let kvStatus = null; // null=未检测, true=可用, false=不可用

async function getKV() {
  if (kvStatus !== null) return kvStatus ? require('@vercel/kv').kv : null;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    kvStatus = true;
    return require('@vercel/kv').kv;
  }
  kvStatus = false;
  return null;
}

const DATA_FILE = path.join(__dirname, "whispers.json");
const KV_KEY = "whispers";

// 读取所有留言
async function readWhispers() {
  const store = await getKV();
  if (store) {
    const data = await store.get(KV_KEY);
    return data || [];
  }
  // 降级：本地文件
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

// 写入留言
async function writeWhispers(list) {
  const store = await getKV();
  if (store) {
    await store.set(KV_KEY, list);
    return;
  }
  // 降级：本地文件
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), "utf8");
}

// 本地降级模式：首次运行自动创建空文件
(async () => {
  const store = await getKV();
  if (!store && !fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, "[]", "utf8");
  }
})();

// ========== 图片上传到 GitHub 图床 ==========
const GITHUB_OWNER = "dhrring";
const GITHUB_REPO = "img-host";
const GITHUB_BRANCH = "main";

async function uploadToGitHub(base64Data, filename) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN 未配置");

  // 按日期分目录，避免单目录文件过多
  const now = new Date();
  const datePath = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const randomStr = Math.random().toString(36).substring(2, 8);
  const ext = path.extname(filename) || '.jpg';
  const baseName = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 20) || 'img';
  const filePath = `${datePath}/${Date.now()}-${randomStr}-${baseName}${ext}`;

  const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'personal-website'
    },
    body: JSON.stringify({
      message: `upload image: ${filePath}`,
      content: base64Data,
      branch: GITHUB_BRANCH
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GitHub 上传失败 (${response.status}): ${errText.substring(0, 200)}`);
  }

  // 返回 jsDelivr CDN 加速地址
  return `https://cdn.jsdelivr.net/gh/${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH}/${filePath}`;
}

// ========== API 接口 ==========

// 【接口 1】获取所有悄悄话（给 view-whispers.html 用）
app.get("/api/whispers", async (req, res) => {
  const list = await readWhispers();
  res.json(list);
});

// 【接口 2】提交新悄悄话（给 whisper.html 用）
app.post("/api/whispers", async (req, res) => {
  try {
    const list = await readWhispers();
    const newMsg = req.body;

    if (!newMsg.time) {
      newMsg.time = new Date().toLocaleString("zh-CN");
    }
    if (!newMsg.id) {
      newMsg.id = Date.now();
    }
    // 确保 images 是数组
    if (!Array.isArray(newMsg.images)) {
      newMsg.images = [];
    }

    list.push(newMsg);
    await writeWhispers(list);
    res.json({ success: true });
  } catch (e) {
    console.error("写入留言失败:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 【接口 3】图片上传（前端压缩后传 base64，后端转存到 GitHub 图床）
app.post("/api/upload", async (req, res) => {
  try {
    const { image, filename } = req.body;
    if (!image) {
      return res.status(400).json({ success: false, error: "缺少图片数据" });
    }

    const safeName = (filename || "image.jpg").replace(/[^a-zA-Z0-9._-]/g, '_');
    const url = await uploadToGitHub(image, safeName);
    res.json({ success: true, url });
  } catch (e) {
    console.error("上传图片失败:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 启动端口
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("服务启动成功"));

module.exports = app;
