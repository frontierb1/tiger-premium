/*
 * config.js — ค่าตั้งต้นของหน้า LIFF ทั้งหมด
 *
 * ★ อยากเปลี่ยนชื่อแบรนด์ / เบอร์พร้อมเพย์ / ราคา → แก้ที่ไฟล์นี้ที่เดียว
 *   ทุกหน้าจะเปลี่ยนตามอัตโนมัติ ไม่ต้องไล่แก้ทีละไฟล์
 */
window.APP = {
  // ===== ชื่อแบรนด์ (แสดงบนหัวเว็บและชื่อแท็บ) =====
  brand: 'Premium Family',
  tagline: 'YouTube Premium ราคาสมาชิกครอบครัว',

  // ===== LINE LIFF =====
  liffId: '2009843737-CwJgLFBY',

  // ===== การชำระเงิน =====
  // เบอร์พร้อมเพย์ที่ใช้สร้าง QR (ต้องเป็นเบอร์ ไม่ใช่เลขบัญชี)
  promptpayId: '0993411929',

  // ★ บัญชีที่แสดงให้ลูกค้าคัดลอก — เพิ่มรายการได้ถ้าอยากมีหลายบัญชี
  //   (พร้อมเพย์ไม่ต้องใส่ตรงนี้ เพราะมี QR ให้สแกนอยู่แล้ว)
  accounts: [
    { label: 'ธนาคารไทยพาณิชย์ (SCB)', number: '8134190505', name: 'กฤษดา พากักดี' },
  ],

  // ===== แพ็กเกจ =====
  packages: [
    { id: '1month',  months: 1, price: 79,  label: '1 เดือน', note: '' },
    { id: '2months', months: 2, price: 155, label: '2 เดือน', note: 'ประหยัดกว่า' },
    { id: '3months', months: 3, price: 230, label: '3 เดือน', note: 'คุ้มที่สุด' },
  ],
};

// ค้นหาแพ็กเกจจาก id
window.APP.pkg = (id) => window.APP.packages.find(p => p.id === id) || null;
window.APP.pkgLabel = (id) => (window.APP.pkg(id)?.label) || id || '-';

// ===== ไอคอน (inline SVG — ไม่ต้องโหลดจากภายนอก) =====
window.ICON = {
  back:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
  plus:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  refresh:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  help:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
  check:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  clock:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  alert:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  mail:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="m2 7 10 6 10-6"/></svg>',
  upload:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v13"/></svg>',
  copy:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  chevron:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  search:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  wrench:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.8 2.8 0 0 1-4-4z"/></svg>',
  send:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>',
};

// ตั้งชื่อแท็บให้ทุกหน้าโดยอัตโนมัติ — ใส่ data-page ที่ <html> เพื่อกำหนดชื่อหน้า
document.addEventListener('DOMContentLoaded', () => {
  const page = document.documentElement.dataset.page;
  document.title = page ? `${page} · ${window.APP.brand}` : window.APP.brand;
  document.querySelectorAll('[data-brand]').forEach(el => { el.textContent = window.APP.brand; });
  document.querySelectorAll('[data-tagline]').forEach(el => { el.textContent = window.APP.tagline; });
  document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = window.ICON[el.dataset.icon] || ''; });
});
