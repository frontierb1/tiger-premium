require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const path = require('path');

const app = express();

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

app.use(express.static(path.join(__dirname, '../public')));

app.post('/webhook', (req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = Buffer.from(data);
    next();
  });
}, line.middleware(lineConfig), require('./webhook'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api', require('./liff-api'));

app.get('/', (req, res) => {
  res.json({ status: 'Tiger Premium OK 🐯', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🐯 Tiger Premium running on port ${PORT}`);
});
