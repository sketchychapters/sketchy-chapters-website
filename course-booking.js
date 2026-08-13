// ==========================================================
// course-booking.js
// إشعار إيميل فوري لما حدا يأكد سلة اختياراته - بدون سيرفر، مجاني
// ==========================================================

const EMAILJS_PUBLIC_KEY = "QmZyguiBME2AwraqZ";
const EMAILJS_SERVICE_ID = "service_bak38zk";
const EMAILJS_TEMPLATE_ID = "template_njeebrx";

// ملاحظة: ADMIN_EMAIL معرّف أصلاً بملف firebase-init.js (يلي لازم يتحمّل قبل هاد الملف) - ما منعرّفه هون مرة تانية

emailjs.init(EMAILJS_PUBLIC_KEY);

// ==========================================================
// إيميل واحد فيه كل الدورات يلي أكدها الطالب دفعة وحدة (سلة الاختيارات)
// ==========================================================
// مهم: لازم تحدّث Template بحسابك على EmailJS يستخدم هالمتغيرات:
// {{student_name}} {{student_email}} {{student_phone}} {{student_id}}
// {{courses_summary}} (نص متعدد الأسطر فيه كل الدورات)
// {{total_price}} {{course_count}}
window.sendCartEmail = function ({ studentName, studentEmail, studentPhone, studentIdCode, enrollments }) {
  const summary = enrollments.map((en, i) =>
    `${i + 1}. ${en.courseName} — ${en.type === "private" ? "Private" : "Group"} — $${en.finalPrice}` +
    (en.discountApplied ? ` (${en.discountApplied}% off)` : "")
  ).join("\n");

  const total = enrollments.reduce((sum, en) => sum + en.finalPrice, 0);

  emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
    to_email: ADMIN_EMAIL,
    student_name: studentName,
    student_email: studentEmail,
    student_phone: studentPhone || "-",
    student_id: studentIdCode || "-",
    courses_summary: summary,
    total_price: total,
    course_count: enrollments.length
  }).then(() => {
    console.log("Admin notified successfully (cart)");
  }).catch(err => {
    console.error("Cart email notification failed:", err);
  });
};
