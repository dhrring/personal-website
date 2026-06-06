const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();

// 只允许你的网站访问，安全！
app.use(cors({ origin: "https://haorui.xyz" }));
app.use(express.json({ limit: "10mb" }));

// 悄悄话存储文件
const DATA_FILE = path.join(__dirname, "whispers.json");

// 第一次运行自动创建空文件
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, "[]", "utf8");
}

// 【接口 1】获取所有悄悄话（给 view-whispers.html 用）
app.get("/api/whispers", (req, res) => {
  try {
    const data = fs.readFileSync(DATA_FILE, "utf8");
    res.json(JSON.parse(data));
  } catch (e) {
    res.json([]);
  }
});

// 【接口 2】提交新悄悄话（给 whisper.html 用）
app.post("/api/whispers", (req, res) => {
  try {
    const list = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    const newMsg = req.body;
    
    // 自动补全时间
    if (!newMsg.time) {
      newMsg.time = new Date().toLocaleString("zh-CN");
    }
    if (!newMsg.id) {
      newMsg.id = Date.now();
    }

    list.push(newMsg);
    fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), "utf8");
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

// 启动端口
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("服务启动成功"));

module.exports = app;
