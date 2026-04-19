require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const path = require('path');
const { runNotifications } = require('./notify');

const app = express();

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

app.use(express.static(path.join(__dirname, '../public')));

app.use('/webhook', require('./webhook'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api', require('./liff-api'));

app.get('/', (req, res) => {
  res.json({ status: 'Tiger Premium OK 🐯', time: new Date().toISOString() });
});

// Endpoint สำหรับ trigger แจ้งเตือน (เรียกจาก cron)
app.get('/run-notify', async (req, res) => {
  const key = req.query.key;
  if (key !== process.env.NOTIFY_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    await runNotifications();
    res.json({ success: true, time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🐯 Tiger Premium running on port ${PORT}`);
});
