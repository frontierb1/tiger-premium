require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const path = require('path');
const webhookRouter = require('./webhook');
const liffRouter = require('./liff-api');

const app = express();

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

// Static files (LIFF pages)
app.use(express.static(path.join(__dirname, '../public')));

// LINE Webhook (ต้องใช้ raw body)
app.post('/webhook', line.middleware(lineConfig), webhookRouter);

// LIFF API (JSON)
app.use(express.json());
app.use('/api', liffRouter);

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Tiger Premium OK 🐯', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🐯 Tiger Premium running on port ${PORT}`);
});
