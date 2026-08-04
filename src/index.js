require('dotenv').config();

// ตั้ง timezone ของ process ให้เป็นเวลาไทยก่อน require อย่างอื่น
// (Railway/Docker default เป็น UTC — ทำให้ log และการคำนวณวันที่คลาดเคลื่อน 7 ชม.)
process.env.TZ = process.env.TZ || process.env.APP_TZ || 'Asia/Bangkok';

const express = require('express');
const path = require('path');
const { runNotifications } = require('./notify');
const { TZ, stamp } = require('./time');
const BRAND = process.env.BRAND_NAME || 'Tube';   // ชื่อแบรนด์ในข้อความ LINE — ตั้งที่ ENV BRAND_NAME

const app = express();

// Railway อยู่หลัง reverse proxy — ต้องเปิด trust proxy ไม่งั้น req.ip
// จะเป็น IP ของ proxy ทุกคน ทำให้ rate limit ใช้ไม่ได้ผล
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ===== กันพลาดเรื่อง LIFF Endpoint URL =====
// ถ้าตั้ง Endpoint URL เป็น .../liff/index.html (แทนที่จะเป็น .../liff/)
// LINE จะเอาชื่อไฟล์ไปต่อท้ายกลายเป็น /liff/index.html/renew-request.html แล้ว 404
// ดักตรงนี้แล้วส่งต่อไปหน้าที่ถูกให้เอง — ตั้งค่าใน console ผิดก็ยังใช้งานได้
app.get(/^\/liff\/index\.html\/(.+)$/, (req, res) => {
  const target = req.params[0];
  const qs = req.originalUrl.includes('?')
    ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
    : '';
  res.redirect(302, `/liff/${target}${qs}`);
});

app.use(express.static(path.join(__dirname, '../public')));

// webhook ต้องมาก่อน express.json() เพราะต้องใช้ raw body ในการ verify signature
app.use('/webhook', require('./webhook'));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/api', require('./liff-api'));
app.use('/api/admin', require('./admin-api'));

app.get('/', (req, res) => {
  res.json({ status: `${BRAND} OK`, tz: TZ, time: stamp() });
});

// health check สำหรับ Railway / uptime monitor
app.get('/healthz', (req, res) => res.json({ ok: true, time: stamp() }));

app.get('/run-notify', async (req, res) => {
  const key = req.query.key;
  if (!process.env.NOTIFY_KEY) {
    return res.status(503).json({ error: 'NOTIFY_KEY ยังไม่ได้ตั้งค่า' });
  }
  if (key !== process.env.NOTIFY_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    await runNotifications();
    res.json({ success: true, time: stamp() });
  } catch (err) {
    console.error('run-notify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== ตรวจ ENV ที่จำเป็นตอน start =====
const REQUIRED_ENV = ['SHEET_ID', 'GOOGLE_CREDENTIALS', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ ENV ที่จำเป็นยังไม่ได้ตั้ง: ${missing.join(', ')}`);
}
if (!process.env.LINE_LOGIN_CHANNEL_ID) {
  console.warn('⚠️  LINE_LOGIN_CHANNEL_ID ยังไม่ได้ตั้ง — ยังไม่มีการยืนยันตัวตนผู้ใช้ LIFF');
}
if (!process.env.ADMINS_JSON && !process.env.OWNER_USER) {
  console.warn('⚠️  ยังไม่ได้ตั้ง ADMINS_JSON หรือ OWNER_USER — จะเข้า Admin Dashboard ไม่ได้');
}

// ===== Global error handler =====
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack || err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'ระบบขัดข้อง กรุณาลองใหม่ครับ' });
});

// กัน process ตายจาก promise ที่ไม่ได้ catch
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`${BRAND} running on port ${PORT} (timezone: ${TZ})`);
});
