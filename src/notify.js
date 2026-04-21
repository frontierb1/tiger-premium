const { getMembersExpiringIn } = require('./sheets');
const dayjs = require('dayjs');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendLineMessage(userId, text) {
  try {
    const { messagingApi } = require('@line/bot-sdk');
    const client = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    });
    await client.pushMessage({ to: userId, messages: [{ type: 'text', text }] });
    console.log(`✅ ส่งแจ้งเตือนให้ ${userId} สำเร็จ`);
  } catch (err) {
    console.error(`❌ ส่งแจ้งเตือนให้ ${userId} ไม่สำเร็จ:`, err.message);
  }
}

function buildMessage(lineUserId, items) {
  // items = [{ email, expireDate, daysLeft, type }]
  // type = 'expired' | 'soon3' | 'soon7'

  const emojiMap = { expired: '❌', soon3: '🔴', soon7: '⚠️' };
  const titleMap = {
    expired: 'สมาชิกของคุณหมดอายุแล้ว',
    soon3: 'สมาชิกของคุณจะหมดอายุใน 3 วัน!',
    soon7: 'สมาชิกของคุณจะหมดอายุใน 7 วัน',
  };

  // ถ้ามีแค่เมลเดียว
  if (items.length === 1) {
    const item = items[0];
    const emoji = emojiMap[item.type];
    const title = titleMap[item.type];
    return `${emoji} แจ้งเตือน Tiger Premium\n\n${title}\n\n📧 ${item.email}\n📅 หมดอายุ: ${item.expireDate} (เหลืออีก ${item.daysLeft} วัน)\n\nกด "ต่ออายุ" ในเมนูด้านล่างได้เลยครับ `;
  }

  // ถ้ามีหลายเมล → group รวม
  const lines = items.map(item => {
    const emoji = emojiMap[item.type];
    return `${emoji} ${item.email}\n   📅 หมดอายุ: ${item.expireDate} (เหลืออีก ${item.daysLeft} วัน)`;
  }).join('\n\n');

  return `⚠️ แจ้งเตือน Tiger Premium\n\nสมาชิกของคุณมีที่ใกล้หมดอายุ:\n\n${lines}\n\nกด "ต่ออายุ" ในเมนูด้านล่างได้เลยครับ `;
}

async function runNotifications() {
  console.log(`🔔 เริ่มส่งแจ้งเตือน ${dayjs().format('YYYY-MM-DD HH:mm:ss')}`);

  const [rows7, rows3, rows0] = await Promise.all([
    getMembersExpiringIn(7),
    getMembersExpiringIn(3),
    getMembersExpiringIn(0),
  ]);

  // Group by LINE ID
  const grouped = {};

  const addItem = (rows, type, daysLeft) => {
    rows.forEach(row => {
      const lineUserId = row[0];
      const email = row[5] || '-';
      const expireDate = row[3];
      if (!grouped[lineUserId]) grouped[lineUserId] = [];
      // ไม่เพิ่มซ้ำถ้า email+expireDate เหมือนกัน
      const exists = grouped[lineUserId].find(i => i.email === email && i.expireDate === expireDate);
      if (!exists) grouped[lineUserId].push({ email, expireDate, daysLeft, type });
    });
  };

  addItem(rows0, 'expired', 0);
  addItem(rows3, 'soon3', 3);
  addItem(rows7, 'soon7', 7);

  const userIds = Object.keys(grouped);
  let sent = 0;

  for (const lineUserId of userIds) {
    const items = grouped[lineUserId];
    const msg = buildMessage(lineUserId, items);
    await sendLineMessage(lineUserId, msg);
    sent++;
    await sleep(1000);
  }

  console.log(`✅ ส่งแจ้งเตือนเสร็จสิ้น — ส่งทั้งหมด ${sent} คน (7วัน:${rows7.length} | 3วัน:${rows3.length} | หมด:${rows0.length})`);
}

module.exports = { runNotifications };
