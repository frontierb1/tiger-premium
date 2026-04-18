const express = require('express');
const line = require('@line/bot-sdk');
const { getMemberByLineId } = require('./sheets');
const dayjs = require('dayjs');
const router = express.Router();

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const LIFF_ID = process.env.LIFF_ID;
const BASE_URL = process.env.BASE_URL;

router.post('/', async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events;
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error('Event error:', err.message);
    }
  }
});

async function handleEvent(event) {
  if (event.type === 'follow') {
    await sendWelcomeMessage(event.source.userId, event.replyToken);
  }
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    if (text === 'เช็ควันหมดอายุ' || text === 'วันหมดอายุ') {
      await sendExpireInfo(event.source.userId, event.replyToken);
    }
  }
  if (event.type === 'postback') {
    await handlePostback(event);
  }
}

async function sendWelcomeMessage(userId, replyToken) {
  await client.replyMessage({
    replyToken,
    messages: [{
      type: 'text',
      text: '🐯 ยินดีต้อนรับสู่ Tiger Premium!\n\nกดเมนูด้านล่างเพื่อ:\n📋 สมัครสมาชิก\n📅 เช็ควันหมดอายุ\n🔄 ต่ออายุ\n🏠 ดูข้อมูลบ้าน',
    }],
  });
}

async function sendExpireInfo(userId, replyToken) {
  const member = await getMemberByLineId(userId);
  if (!member) {
    await client.replyMessage({
      replyToken,
      messages: [{
        type: 'text',
        text: '❌ ไม่พบข้อมูลสมาชิก\nกรุณาสมัครสมาชิกก่อนครับ',
      }],
    });
    return;
  }

  const expire = dayjs(member.expireDate);
  const daysLeft = expire.diff(dayjs(), 'day');
  const emoji = daysLeft <= 3 ? '🔴' : daysLeft <= 7 ? '🟡' : '🟢';

  await client.replyMessage({
    replyToken,
    messages: [{
      type: 'text',
      text: `${emoji} สถานะสมาชิก Tiger Premium\n\n👤 ${member.displayName}\n📅 หมดอายุ: ${member.expireDate}\n⏰ เหลืออีก ${daysLeft} วัน\n\n${daysLeft <= 7 ? '⚠️ ใกล้หมดอายุแล้ว! กด "ต่ออายุ" ในเมนูได้เลยครับ' : '✅ ยังใช้งานได้ปกติครับ'}`,
    }],
  });
}

async function handlePostback(event) {
  const data = event.postback.data;
  // รองรับ postback จาก Rich Menu
}

module.exports = router;
