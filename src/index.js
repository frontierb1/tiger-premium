require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const path = require('path');

const app = express();

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

// Static files (LIFF pages)
app.use(express.static(path.join(__dirname, '../public')));

// LINE Webhook ต้องมาก่อน express.json()
app.post('/webhook',
  line.middleware(lineConfig),
  require('./webhook')
);

// LIFF API ใช้ JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api', require('./liff-api'));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Tiger Premium OK 🐯', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🐯 Tiger Premium running on port ${PORT}`);
});
