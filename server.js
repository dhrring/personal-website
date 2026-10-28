const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// 允许网站域名和本地开发访问
app.use(cors({ origin: ["https://haorui.xyz", "http://localhost:3000"] }));
// 文档（PPT/PDF 等）经 base64 编码后体积增大约 1/3，放宽请求体上限
app.use(express.json({ limit: "30mb" }));

// ========== 数据存储层（多频道隔离） ==========
// 优先使用 Vercel KV（Upstash Redis REST）。每次调用前先做带超时的可达性探测，
// KV 不可达（如数据库被删除导致域名 NXDOMAIN）时快速降级，避免函数挂起超时。
// 降级文件：Vercel 上为 /tmp（临时、实例间不共享，仅兜底）；本地开发为项目目录（可持久）。
//
// 频道隔离规则：
//   默认频道 (default / 不传) → KV key "whispers", 文件 whispers.json（兼容原有数据）
//   命名频道 (如 mahong)      → KV key "whispers:mahong", 文件 whispers-mahong.json

const DATA_DIR = process.env.VERCEL ? "/tmp" : __dirname;

let kvHealth = null;  // null=未探测, true=可达, false=不可达
let kvCheckAt = 0;

// 探测 KV REST 端点是否可达（带 3s 超时），结果缓存 60s
async function checkKV() {
  if (kvHealth !== null && Date.now() - kvCheckAt < 60000) return kvHealth;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    kvHealth = false;
    kvCheckAt = Date.now();
    return false;
  }
  try {
    // 直接 fetch 端点：能拿到任何 HTTP 响应即说明 DNS 正常、主机可达
    const u = process.env.KV_REST_API_URL.replace(/\/$/, '') + '/get/__probe__';
    await fetch(u, {
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
      signal: AbortSignal.timeout(3000)
    });
    kvHealth = true;
  } catch (e) {
    kvHealth = false; // ENOTFOUND / 超时等
  }
  kvCheckAt = Date.now();
  return kvHealth;
}

// 根据频道返回 KV key（默认频道兼容旧 key "whispers"）
function getKVKey(channel) {
  if (!channel || channel === 'default') return 'whispers';
  return `whispers:${channel}`;
}

// 根据频道返回数据文件路径（默认频道兼容旧文件 whispers.json）
function getDataFile(channel) {
  if (!channel || channel === 'default') return path.join(DATA_DIR, "whispers.json");
  return path.join(DATA_DIR, `whispers-${channel}.json`);
}

// 带超时执行 KV 操作（双保险，防止 @vercel/kv 客户端内部重试导致挂起）
function withKVTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}超时(${ms}ms)`)), ms))
  ]);
}

// 读取指定频道的所有留言
async function readWhispers(channel) {
  const KV_KEY = getKVKey(channel);
  const DATA_FILE = getDataFile(channel);
  if (await checkKV()) {
    try {
      const data = await withKVTimeout(require('@vercel/kv').kv.get(KV_KEY), 5000, "KV读取");
      return data || [];
    } catch (e) {
      kvHealth = false; kvCheckAt = Date.now(); // 探测外的运行期失败，重新标记
    }
  }
  // 降级：本地文件
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

// 写入指定频道的留言
async function writeWhispers(channel, list) {
  const KV_KEY = getKVKey(channel);
  const DATA_FILE = getDataFile(channel);
  if (await checkKV()) {
    try {
      await withKVTimeout(require('@vercel/kv').kv.set(KV_KEY, list), 5000, "KV写入");
      return;
    } catch (e) {
      kvHealth = false; kvCheckAt = Date.now();
    }
  }
  // 降级：本地文件
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), "utf8");
}

// ========== 文件上传到 GitHub 图床（图片 + 文档） ==========
const GITHUB_OWNER = "dhrring";
const GITHUB_REPO = "img-host";
const GITHUB_BRANCH = "main";

// 生成按日期分目录的文件路径
function buildFilePath(filename) {
  const now = new Date();
  const datePath = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const randomStr = Math.random().toString(36).substring(2, 8);
  // 保留原始扩展名（图片 .jpg/.png，文档 .pdf/.docx/.pptx 等），统一转小写
  let ext = path.extname(filename) || '.bin';
  ext = ext.toLowerCase();
  const baseName = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30) || 'file';
  return `${datePath}/${Date.now()}-${randomStr}-${baseName}${ext}`;
}

async function ghFetch(url, options) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN 未配置");
  return fetch(url, {
    ...options,
    headers: {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'personal-website',
      ...(options && options.headers ? options.headers : {})
    }
  });
}

// 通过 Git Data API（blob → tree → commit → ref）上传，单文件最大约 100MB
// Contents API 仅支持 1MB 以内文件，无法满足文档上传需求
async function commitFileToGitHub(filePath, base64Data, attempt = 1) {
  const base = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

  // 1. 获取分支最新 commit
  const refRes = await ghFetch(`${base}/git/ref/heads/${GITHUB_BRANCH}`);
  if (!refRes.ok) throw new Error(`获取分支引用失败 (${refRes.status})`);
  const refData = await refRes.json();
  const parentCommitSha = refData.object.sha;

  // 2. 获取父 commit 的 tree
  const commitRes = await ghFetch(`${base}/git/commits/${parentCommitSha}`);
  if (!commitRes.ok) throw new Error(`获取提交信息失败 (${commitRes.status})`);
  const commitData = await commitRes.json();
  const baseTreeSha = commitData.tree.sha;

  // 3. 创建 blob（base64）
  const blobRes = await ghFetch(`${base}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: base64Data, encoding: 'base64' })
  });
  if (!blobRes.ok) {
    const t = await blobRes.text();
    throw new Error(`创建文件块失败 (${blobRes.status}): ${t.substring(0, 150)}`);
  }
  const blobData = await blobRes.json();

  // 4. 基于原 tree 创建新 tree
  const treeRes = await ghFetch(`${base}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blobData.sha }]
    })
  });
  if (!treeRes.ok) throw new Error(`创建目录树失败 (${treeRes.status})`);
  const treeData = await treeRes.json();

  // 5. 创建 commit
  const newCommitRes = await ghFetch(`${base}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: `upload: ${filePath}`,
      tree: treeData.sha,
      parents: [parentCommitSha]
    })
  });
  if (!newCommitRes.ok) throw new Error(`创建提交失败 (${newCommitRes.status})`);
  const newCommitData = await newCommitRes.json();

  // 6. 更新分支引用（fast-forward）。并发冲突时有限重试
  const updateRes = await ghFetch(`${base}/git/refs/heads/${GITHUB_BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommitData.sha, force: false })
  });
  if (!updateRes.ok) {
    if (attempt < 3) {
      // 引用过期（并发上传），重新基于最新提交再走一遍
      return commitFileToGitHub(filePath, base64Data, attempt + 1);
    }
    throw new Error(`更新分支引用失败 (${updateRes.status})`);
  }
  return newCommitData.sha;
}

// 上传并返回 jsDelivr CDN 地址
async function uploadToGitHub(base64Data, filename) {
  if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN 未配置");
  const filePath = buildFilePath(filename);
  await commitFileToGitHub(filePath, base64Data);
  return `https://cdn.jsdelivr.net/gh/${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH}/${filePath}`;
}

// ========== API 接口 ==========

// 【诊断】检查 KV 连接状态（不经过 KV 客户端，直接测 REST）
app.get("/api/diag", async (req, res) => {
  const result = { time: new Date().toISOString() };
  result.kvUrlSet = !!process.env.KV_REST_API_URL;
  result.kvTokenSet = !!process.env.KV_REST_API_TOKEN;
  result.githubTokenSet = !!process.env.GITHUB_TOKEN;
  if (process.env.KV_REST_API_URL) {
    try {
      result.kvHost = new URL(process.env.KV_REST_API_URL).host;
    } catch (e) { result.kvHost = 'URL解析失败'; }
  }
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const start = Date.now();
      const u = process.env.KV_REST_API_URL.replace(/\/$/, '') + '/get/whispers';
      const r = await fetch(u, {
        headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
        signal: ctrl.signal
      });
      clearTimeout(timer);
      result.kvDirectStatus = r.status;
      result.kvDirectMs = Date.now() - start;
      result.kvDirectBody = (await r.text()).slice(0, 200);
    } catch (e) {
      result.kvDirectError = e.name + ': ' + e.message;
      // 递归提取底层 cause（ENOTFOUND / ECONNREFUSED / CERT 等）
      const causes = [];
      let c = e.cause;
      let depth = 0;
      while (c && depth < 4) {
        causes.push({ code: c.code, message: c.message, syscall: c.syscall, hostname: c.hostname });
        c = c.cause;
        depth++;
      }
      result.kvErrorCauses = causes;
    }
  }
  // 对照：测试函数出站网络与 DNS 是否正常（访问 GitHub API）
  try {
    const cr = await fetch("https://api.github.com/zen", {
      signal: AbortSignal.timeout(6000),
      headers: { "User-Agent": "diag" }
    });
    result.controlGithubStatus = cr.status;
  } catch (e) {
    result.controlGithubError = e.name + ": " + e.message;
  }
  res.json(result);
});

// 【接口 1】获取指定频道的悄悄话
//   GET /api/whispers?channel=mahong   （不传 channel 则为默认频道，兼容旧版）
app.get("/api/whispers", async (req, res) => {
  const channel = req.query.channel || 'default';
  const list = await readWhispers(channel);
  res.json(list);
});

// 【接口 2】提交新悄悄话到指定频道
//   POST /api/whispers  body 中带 channel 字段（如 "mahong"），不传则为默认频道
app.post("/api/whispers", async (req, res) => {
  try {
    const channel = req.body.channel || req.query.channel || 'default';
    const list = await readWhispers(channel);
    const newMsg = req.body;

    // 不把 channel 字段存进留言数据
    delete newMsg.channel;

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
    // 确保 files 是数组（文档附件）
    if (!Array.isArray(newMsg.files)) {
      newMsg.files = [];
    }

    list.push(newMsg);
    await writeWhispers(channel, list);
    res.json({ success: true });
  } catch (e) {
    console.error("写入留言失败:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 【接口 3】通用文件上传（图片压缩后 / 文档原始 base64，后端转存到 GitHub 图床）
// 所有频道共用同一个图床，文件本身不涉及隐私隔离
// 兼容字段：data（新，通用）或 image（旧，图片）
app.post("/api/upload", async (req, res) => {
  try {
    const data = req.body.data || req.body.image;
    const { filename } = req.body;
    if (!data) {
      return res.status(400).json({ success: false, error: "缺少文件数据" });
    }

    const safeName = (filename || "file.bin").replace(/[^a-zA-Z0-9._-]/g, '_');
    const url = await uploadToGitHub(data, safeName);
    res.json({ success: true, url });
  } catch (e) {
    console.error("上传文件失败:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 启动端口
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("服务启动成功"));

module.exports = app;
