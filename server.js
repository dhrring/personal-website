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

    list.push(newMsg);
    await writeWhispers(list);
    res.json({ success: true });
  } catch (e) {
    console.error("写入留言失败:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 启动端口
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("服务启动成功"));

module.exports = app;
