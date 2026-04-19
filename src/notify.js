const { getMembersExpiringIn } = require('./sheets');
const dayjs = require('dayjs');

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

async function runNotifications() {
  console.log(`🔔 เริ่มส่งแจ้งเตือน ${dayjs().format('YYYY-MM-DD HH:mm:ss')}`);

  // แจ้งเตือน 7 วันก่อนหมด
  const expiring7 = await getMembersExpiringIn(7);
  for (const member of expiring7) {
    await sendLineMessage(member[0],
      `⚠️ แจ้งเตือน Tiger Premium\n\nสมาชิกของคุณจะหมดอายุใน 7 วัน\n📅 วันหมดอายุ: ${member[3]}\n\nกด "ต่ออายุ" ในเมนูด้านล่างเพื่อต่ออายุได้เลยครับ 🐯`
    );
  }

  // แจ้งเตือน 3 วันก่อนหมด
  const expiring3 = await getMembersExpiringIn(3);
  for (const member of expiring3) {
    await sendLineMessage(member[0],
      `🔴 แจ้งเตือนด่วน Tiger Premium\n\nสมาชิกของคุณจะหมดอายุใน 3 วัน!\n📅 วันหมดอายุ: ${member[3]}\n\nอย่าลืมต่ออายุนะครับ กด "ต่ออายุ" ในเมนูได้เลย 🐯`
    );
  }

  // แจ้งเตือนวันที่หมด
  const expiring0 = await getMembersExpiringIn(0);
  for (const member of expiring0) {
    await sendLineMessage(member[0],
      `❌ สมาชิก Tiger Premium หมดอายุแล้ว\n\n📅 หมดอายุ: ${member[3]}\n\nกด "ต่ออายุ" ในเมนูด้านล่างเพื่อใช้งานต่อได้เลยครับ 🐯`
    );
  }

  console.log(`✅ ส่งแจ้งเตือนเสร็จสิ้น (7วัน:${expiring7.length} | 3วัน:${expiring3.length} | หมด:${expiring0.length})`);
}

module.exports = { runNotifications };
