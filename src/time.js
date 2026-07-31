// ===== Timezone helper =====
// ทุกการคำนวณวันที่ในระบบต้องอิงเวลาไทย (Asia/Bangkok) ไม่ใช่ UTC ของ server
// Railway/Docker รันบน UTC → ถ้าไม่ fix จะคลาดเคลื่อน 7 ชม. (ช่วง 00:00-07:00 น. ไทย
// ระบบจะคิดว่ายังเป็น "เมื่อวาน" ทำให้วันหมดอายุและแจ้งเตือนเพี้ยนไป 1 วัน)

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const TZ = process.env.APP_TZ || 'Asia/Bangkok';
dayjs.tz.setDefault(TZ);

/** เวลาปัจจุบันตามเขตเวลาไทย */
function now() {
  return dayjs().tz(TZ);
}

/** วันที่วันนี้ (ไทย) รูปแบบ YYYY-MM-DD */
function today() {
  return now().format('YYYY-MM-DD');
}

/** timestamp สำหรับเขียนลง Sheet รูปแบบ YYYY-MM-DD HH:mm:ss (เวลาไทย) */
function stamp() {
  return now().format('YYYY-MM-DD HH:mm:ss');
}

/**
 * แปลงค่าวันที่จาก Sheet ("YYYY-MM-DD" หรือ "YYYY-MM-DD HH:mm:ss") เป็น dayjs ต้นวันตามเวลาไทย
 * คืน null ถ้าค่าไม่ใช่วันที่ (เช่น เซลล์ว่าง หรือแอดมินพิมพ์อะไรผิดใน Sheet)
 * — ต้องเช็ครูปแบบก่อน เพราะ dayjs.tz() จะ throw RangeError ถ้าได้ค่าที่แปลงไม่ได้
 */
function parseDate(value) {
  if (!value) return null;
  const d = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  try {
    const parsed = dayjs.tz(d, 'YYYY-MM-DD', TZ);
    return parsed.isValid() ? parsed.startOf('day') : null;
  } catch (e) {
    return null;
  }
}

/**
 * จำนวนวันที่เหลือก่อนหมดอายุ (นับเป็นวันปฏิทินไทย)
 * เช่น หมดอายุพรุ่งนี้ = 1, หมดอายุวันนี้ = 0, หมดอายุเมื่อวาน = -1
 */
function daysLeft(expireDate) {
  const target = parseDate(expireDate);
  if (!target) return 0;
  return target.diff(now().startOf('day'), 'day');
}

/** วันที่ในอีก n วันข้างหน้า (ไทย) รูปแบบ YYYY-MM-DD */
function addDays(n) {
  return now().startOf('day').add(n, 'day').format('YYYY-MM-DD');
}

module.exports = { dayjs, TZ, now, today, stamp, parseDate, daysLeft, addDays };
