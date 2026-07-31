// ===== In-memory TTL cache =====
// ลดจำนวน request ที่ยิงไป Google Sheets API (มี quota 60 read/นาที/user)
// Admin Dashboard เปิดทีนึงยิงหลาย endpoint พร้อมกัน — cache สั้นๆ ช่วยได้มาก
// ทุกครั้งที่มีการเขียน ต้องเรียก invalidate() เพื่อไม่ให้ข้อมูลค้าง

const DEFAULT_TTL_MS = parseInt(process.env.CACHE_TTL_MS || '15000', 10);

const store = new Map(); // key -> { value, expiresAt }
const inflight = new Map(); // key -> Promise (กัน request ซ้อนตอน cache miss พร้อมกัน)

/**
 * อ่านจาก cache ถ้ายังไม่หมดอายุ ไม่งั้นเรียก loader()
 * ถ้ามี request เดียวกันกำลังโหลดอยู่ จะรอผลอันเดิม (ไม่ยิงซ้ำ)
 */
async function cached(key, loader, ttlMs = DEFAULT_TTL_MS) {
  if (ttlMs <= 0) return loader();

  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    try {
      const value = await loader();
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/** ล้าง cache — ระบุ prefix เพื่อล้างเฉพาะกลุ่ม (เช่น 'members') หรือไม่ระบุเพื่อล้างทั้งหมด */
function invalidate(prefix) {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

module.exports = { cached, invalidate, DEFAULT_TTL_MS };
