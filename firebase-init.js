// ==========================================================
// firebase-init.js
// شغل هيدا الملف مرة وحدة، وحطو بنفس مجلد باقي صفحات الموقع
// لازم ينضاف بـ <script> بكل صفحة قبل أي كود تاني يستخدم Firebase
// ==========================================================
// مشروع Firebase: sketchy-chapters (معبى ✅)

const firebaseConfig = {
  apiKey: "AIzaSyDOojwwATzwl93nFCXJxnUDm3LlOSHspgQ",
  authDomain: "sketchy-chapters.firebaseapp.com",
  projectId: "sketchy-chapters",
  storageBucket: "sketchy-chapters.firebasestorage.app",
  messagingSenderId: "621602801375",
  appId: "1:621602801375:web:2a387c8bd32623fa718b6a"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// ==========================================================
// نظام النقاط والمستويات (Points & Levels)
// ==========================================================

// كل 1$ يدفعه الطالب = 5 نقاط (عدّل الرقم هون إذا تغيّر بالمستقبل)
const POINTS_PER_DOLLAR = 5;

// جدول المستويات الأصلي (زي الجدول الأول تبعك بالضبط)
const LEVELS = [
  { name: "Basic",    nameAr: "أساسي",    min: 0,    courseDiscount: 0,  referralDiscount: 0,  birthdayDiscount: 20, freeCourseYearly: false },
  { name: "Classic",  nameAr: "كلاسيك",   min: 1000, courseDiscount: 10, referralDiscount: 5,  birthdayDiscount: 30, freeCourseYearly: false },
  { name: "Gold",     nameAr: "ذهبي",     min: 2000, courseDiscount: 15, referralDiscount: 10, birthdayDiscount: 40, freeCourseYearly: false },
  { name: "Platinum", nameAr: "بلاتيني",  min: 4000, courseDiscount: 20, referralDiscount: 15, birthdayDiscount: 50, freeCourseYearly: true  }
];

// ==========================================================
// متطلبات مسبقة بين الدورات - زيد أي دورة هون لما تحب تربطها بدورة تانية لازم تنسجل قبلها
// المفتاح = اسم الدورة، القيمة = مصفوفة أسماء الدورات المطلوبة قبلها
// ==========================================================
const COURSE_PREREQUISITES = {
  "Revit Architecture — Advanced + V-Ray": ["Revit Architecture — Foundation"]
};

// بيتأكد إذا الطالب مؤهل يسجل بدورة معينة (خد بعين الاعتبار تسجيلاته الحالية + محتويات السلة الحالية)
function checkPrerequisites(courseName, existingEnrollments, cartItems) {
  const required = COURSE_PREREQUISITES[courseName];
  if (!required) return { ok: true };

  for (const req of required) {
    const hasIt =
      (existingEnrollments || []).some(en => en.courseName === req && en.status !== "cancelled") ||
      (cartItems || []).some(item => item.courseName === req);
    if (!hasIt) return { ok: false, missing: req };
  }
  return { ok: true };
}

// بيرجع كائن المستوى الحالي حسب عدد النقاط
function computeLevel(points) {
  points = points || 0;
  let current = LEVELS[0];
  for (const lvl of LEVELS) {
    if (points >= lvl.min) current = lvl;
  }
  return current;
}

// بيرجع المستوى الجاي (لعرض "باقيلك كم نقطة" بصفحة الحساب)
function nextLevel(points) {
  points = points || 0;
  for (const lvl of LEVELS) {
    if (points < lvl.min) return lvl;
  }
  return null; // وصل لأعلى مستوى
}

// ==========================================================
// توليد رقم تسلسلي (Student ID) لكل طالب جديد
// الصيغة: السنة + رقم يبلش من 10001 (مش من 1) - عشان ما يبين عدد الطلاب الحقيقي
// مثال: أول طالب بسنة 2026 بياخد 202610001، وبيرجع يبلش من جديد كل سنة
// ==========================================================
async function generateStudentId() {
  const year = new Date().getFullYear();
  const counterRef = db.collection("meta").doc("studentCounter_" + year);
  const newNumber = await db.runTransaction(async (t) => {
    const doc = await t.get(counterRef);
    const current = doc.exists ? (doc.data().count || 10000) : 10000;
    const next = current + 1;
    t.set(counterRef, { count: next }, { merge: true });
    return next;
  });
  return String(year) + String(newNumber);
}

// ==========================================================
// تسجيل حساب جديد
// ==========================================================
async function signUpStudent({ name, email, password, birthDate, phone, gender, referredBy, country, specialization }) {
  const cred = await auth.createUserWithEmailAndPassword(email, password);
  const uid = cred.user.uid;
  const studentId = await generateStudentId();

  await db.collection("students").doc(uid).set({
    studentId,
    name,
    email,
    phone: phone || "",
    gender: gender || "",           // "male" | "female"
    birthDate: birthDate,
    country: country || "",
    specialization: specialization || "",
    referredBy: referredBy || "",   // studentId تبع اللي حولّه (اختياري)
    points: 0,
    freeCourseUsedYear: null,       // آخر سنة استخدم فيها الكورس المجاني (Platinum)
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    enrollments: []
  });

  // خريطة بسيطة: رقم الطالب -> إيميله (عشان الطالب يقدر يدخل بالـ ID بدل الإيميل)
  await db.collection("studentIdLookup").doc(studentId).set({ email, uid });

  return uid;
}

// تسجيل دخول بالإيميل أو برقم الطالب (Student ID) - أيهم بده الطالب
async function loginStudent(identifier, password) {
  let email = (identifier || "").trim();

  if (!email.includes("@")) {
    // مش شكل إيميل -> اعتبره Student ID ودور عن الإيميل المرتبط فيه
    const lookupDoc = await db.collection("studentIdLookup").doc(email).get();
    if (!lookupDoc.exists) throw new Error("STUDENT_ID_NOT_FOUND");
    email = lookupDoc.data().email;
  }

  const cred = await auth.signInWithEmailAndPassword(email, password);
  return cred.user.uid;
}

function logoutStudent() {
  // نصفّر أي كورسات مضافة للسلة وما تثبتت - ما بدنا نخليها معلقة لجلسة تانية
  try { localStorage.removeItem('sketchy_cart'); } catch (e) {}
  return auth.signOut();
}

async function getCurrentStudentData() {
  const user = auth.currentUser;
  if (!user) return null;
  const doc = await db.collection("students").doc(user.uid).get();
  return doc.exists ? { uid: user.uid, ...doc.data() } : null;
}

// حروف الأفاتار (أول حرف من الاسم الأول وأول حرف من اسم العيلة)
// معرّف فريد حقيقي لكل تسجيل دورة - عشان دورتين بنفس اللحظة بالضبط ما ينلخبطوا مع بعض
function generateEnrollmentId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
}

function getInitials(fullName) {
  if (!fullName) return "?";
  const parts = fullName.trim().split(/\s+/);
  const first = parts[0] ? parts[0].charAt(0) : "";
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
}

// ==========================================================
// خصم عيد الميلاد: بيتفعل بس بأسبوع عيد ميلاد الطالب
// بيرجع نسبة خصم عيد الميلاد الخاصة بمستوى الطالب
// ==========================================================
function isBirthdayWeek(birthDateStr) {
  if (!birthDateStr) return false;
  const today = new Date();
  const bd = new Date(birthDateStr);
  const birthdayThisYear = new Date(today.getFullYear(), bd.getMonth(), bd.getDate());
  const diffDays = Math.abs((birthdayThisYear - today) / (1000 * 60 * 60 * 24));
  return diffDays <= 7;
}

// ==========================================================
// تسجيل بدورة (Group أو Private) + نقاط + خصومات حسب المستوى
// noDiscount:true بيلغي خصم عيد الميلاد بس (لصفحات offers/oea)
// خصم المستوى (Level Discount) بيضل شغال دايماً
// ==========================================================
async function enrollInCourse({ courseName, basePrice, type, noDiscount, redeemFreeCourse }) {
  const user = auth.currentUser;
  if (!user) {
    window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.pathname);
    return;
  }

  const studentData = await getCurrentStudentData();
  if (!studentData) {
    // ملف الطالب مش موجود بقاعدة البيانات (حساب اتعمل بشكل ناقص) - ما فينا نكمل
    throw new Error("PROFILE_MISSING");
  }

  // منع التسجيل بنفس الدورة مرتين وهي لسا نشطة (قيد الموافقة أو قادمة)
  const existingEnrollments = studentData.enrollments || [];
  const alreadyActive = existingEnrollments.some(
    en => en.courseName === courseName && en.status !== "completed" && en.status !== "cancelled"
  );
  if (alreadyActive) {
    throw new Error("ALREADY_ENROLLED");
  }

  const level = computeLevel(studentData.points);

  // إذا الطالب بلاتيني وبده يستخدم الكورس المجاني السنوي
  const thisYear = new Date().getFullYear();
  const canRedeemFree = level.freeCourseYearly && studentData.freeCourseUsedYear !== thisYear;

  let finalPrice = basePrice;
  let discountApplied = 0;
  let usedFreeCourse = false;

  if (redeemFreeCourse && canRedeemFree) {
    finalPrice = 0;
    discountApplied = 100;
    usedFreeCourse = true;
  } else {
    if (type === "private") finalPrice = finalPrice * 2;

    // نختار الأكبر بين خصم المستوى العادي وخصم عيد الميلاد (ما يتكدسوا فوق بعض)
    let bestDiscount = level.courseDiscount;
    if (!noDiscount && isBirthdayWeek(studentData.birthDate)) {
      bestDiscount = Math.max(bestDiscount, level.birthdayDiscount);
    }
    if (bestDiscount > 0) {
      finalPrice = finalPrice - (finalPrice * bestDiscount / 100);
    }
    discountApplied = bestDiscount;
  }

  const pointsEarned = Math.round(finalPrice * POINTS_PER_DOLLAR);

  const enrollment = {
    id: generateEnrollmentId(),
    courseName,
    type,
    basePrice,
    discountApplied,
    finalPrice,
    pointsEarned,        // النقاط المحتسبة - بس ما بتنضاف لرصيد الطالب إلا لما الدورة توصل حالة "completed"
    status: "pending",   // pending (لسا ما وافقنا) -> upcoming (موافق عليها، ما تنلغى) -> completed
    date: new Date().toISOString()
  };

  // ملاحظة مهمة: ما منزيد رصيد النقاط هون - النقاط بتنضاف بس لما الأدمن يأكد إنو الطالب خلّص الدورة فعلياً
  // (من صفحة الأدمن، زر "Mark Completed") - هيك ما حدا بيستفيد من خصم مستوى أعلى قبل ما يخلّص دوراته الفعلية
  const updates = {
    enrollments: firebase.firestore.FieldValue.arrayUnion(enrollment)
  };
  if (usedFreeCourse) updates.freeCourseUsedYear = thisYear;

  // set + merge بدل update: بيكتب حتى لو في حقل ناقص، وما بيفشل بصمت
  await db.collection("students").doc(user.uid).set(updates, { merge: true });

  if (window.sendEnrollmentEmail) {
    window.sendEnrollmentEmail({
      studentName: studentData.name,
      studentEmail: studentData.email,
      studentPhone: studentData.phone,
      studentIdCode: studentData.studentId,
      ...enrollment
    });
  }

  return enrollment;
}

// ==========================================================
// تسجيل دفعة كورسات مرة وحدة (سلة الاختيارات) - كتابة وحدة + إيميل وحد
// cartItems: [{ courseName, basePrice, type, redeemFreeCourse }, ...]
// بيرجع { added: [...], skipped: [أسماء الدورات المكررة] }
// ==========================================================
async function submitCart(cartItems) {
  const user = auth.currentUser;
  if (!user) {
    window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.pathname);
    return null;
  }

  const studentData = await getCurrentStudentData();
  if (!studentData) throw new Error("PROFILE_MISSING");

  const level = computeLevel(studentData.points);
  const thisYear = new Date().getFullYear();
  const noDiscount = window.DISABLE_BIRTHDAY_DISCOUNT === true;

  const existingEnrollments = studentData.enrollments || [];
  const newEnrollments = [];
  const skipped = [];
  let freeCourseUsedThisSubmission = false;

  for (const item of cartItems) {
    const alreadyActive =
      existingEnrollments.some(en => en.courseName === item.courseName && en.status !== "completed" && en.status !== "cancelled") ||
      newEnrollments.some(en => en.courseName === item.courseName);

    if (alreadyActive) {
      skipped.push(item.courseName);
      continue;
    }

    const prereq = checkPrerequisites(item.courseName, existingEnrollments.concat(newEnrollments), []);
    if (!prereq.ok) {
      skipped.push(`${item.courseName} (requires ${prereq.missing} first)`);
      continue;
    }

    let finalPrice = item.basePrice;
    let discountApplied = 0;
    let usedFreeCourse = false;

    const canRedeemFree = level.freeCourseYearly && studentData.freeCourseUsedYear !== thisYear && !freeCourseUsedThisSubmission;

    if (item.redeemFreeCourse && canRedeemFree) {
      finalPrice = 0;
      discountApplied = 100;
      usedFreeCourse = true;
      freeCourseUsedThisSubmission = true;
    } else {
      if (item.type === "private") finalPrice = finalPrice * 2;

      let bestDiscount = level.courseDiscount;
      if (!noDiscount && isBirthdayWeek(studentData.birthDate)) {
        bestDiscount = Math.max(bestDiscount, level.birthdayDiscount);
      }
      // خصم خاص حطّه الأدمن لهالطالب بالذات - إما لدورة محددة أو لكل الدورات ("*")
      const specialDiscounts = studentData.specialDiscounts || [];
      const specialMatch = specialDiscounts.find(sd => sd.courseName === item.courseName || sd.courseName === "*");
      if (specialMatch) {
        bestDiscount = Math.max(bestDiscount, specialMatch.discountPercent);
      }
      if (bestDiscount > 0) finalPrice = finalPrice - (finalPrice * bestDiscount / 100);
      discountApplied = bestDiscount;
    }

    newEnrollments.push({
      id: generateEnrollmentId(),
      courseName: item.courseName,
      type: item.type,
      basePrice: item.basePrice,
      discountApplied,
      finalPrice,
      pointsEarned: Math.round(finalPrice * POINTS_PER_DOLLAR), // بتنضاف لرصيده بس لما توصل completed
      status: "pending",
      date: new Date().toISOString(),
      usedFreeCourse
    });
  }

  if (newEnrollments.length === 0) {
    return { added: [], skipped };
  }

  const updates = {
    enrollments: firebase.firestore.FieldValue.arrayUnion(...newEnrollments)
  };
  if (freeCourseUsedThisSubmission) updates.freeCourseUsedYear = thisYear;

  await db.collection("students").doc(user.uid).set(updates, { merge: true });

  if (window.sendCartEmail) {
    window.sendCartEmail({
      studentName: studentData.name,
      studentEmail: studentData.email,
      studentPhone: studentData.phone,
      studentIdCode: studentData.studentId,
      enrollments: newEnrollments
    });
  }

  return { added: newEnrollments, skipped };
}

function requireLogin() {
  auth.onAuthStateChanged(user => {
    if (!user) window.location.href = "login.html";
  });
}

// ==========================================================
// دوال خاصة بصفحة الأدمن (admin.html)
// ==========================================================
const ADMIN_EMAIL = "info@sketchychapters.com";

async function loginAdmin(email, password) {
  const cred = await auth.signInWithEmailAndPassword(email, password);
  if (cred.user.email !== ADMIN_EMAIL) {
    await auth.signOut();
    throw new Error("This account is not authorized as admin.");
  }
  return cred.user.uid;
}

function requireAdmin() {
  auth.onAuthStateChanged(user => {
    if (!user || user.email !== ADMIN_EMAIL) {
      window.location.href = "sc-team-login.html";
    }
  });
}

async function getAllStudents() {
  const snapshot = await db.collection("students").orderBy("createdAt", "desc").get();
  return snapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() }));
}

// ==========================================================
// نظام الإشعارات - جرس الإشعارات بالهيدر + قسم بصفحة الحساب
// ==========================================================
async function addNotification(studentUid, message) {
  const notif = {
    message,
    date: new Date().toISOString(),
    read: false
  };
  await db.collection("students").doc(studentUid).update({
    notifications: firebase.firestore.FieldValue.arrayUnion(notif)
  });
}

// الطالب بيفتح جرس الإشعارات -> منعلّم كلها مقروءة، ومنمسح يلي عمرها أكتر من شهر
async function markAllNotificationsRead() {
  const user = auth.currentUser;
  if (!user) return;
  const ref = db.collection("students").doc(user.uid);
  const doc = await ref.get();

  const oneMonthAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const notifications = (doc.data().notifications || [])
    .filter(n => new Date(n.date).getTime() >= oneMonthAgo) // احذف يلي أقدم من شهر
    .map(n => ({ ...n, read: true }));

  await ref.update({ notifications });
}

// إشعار عيد ميلاد تلقائي - مرة وحدة بالسنة بس، وقت ما الطالب يفتح حسابه بأسبوع عيد ميلاده
async function checkAndNotifyBirthday() {
  const user = auth.currentUser;
  if (!user) return;
  const data = await getCurrentStudentData();
  if (!data || !data.birthDate) return;
  if (!isBirthdayWeek(data.birthDate)) return;

  const thisYear = new Date().getFullYear();
  if (data.lastBirthdayNotifiedYear === thisYear) return;

  const level = computeLevel(data.points || 0);
  await addNotification(user.uid, `🎂 عيد ميلاد سعيد! يحق لك الحصول على خصم خاص ${level.birthdayDiscount}% على أي دورة هذا الأسبوع.`);
  await db.collection("students").doc(user.uid).update({ lastBirthdayNotifiedYear: thisYear });
}

// الأدمن بيبعت إعلان/عرض/خصم جديد لكل الطلاب دفعة وحدة
async function broadcastAnnouncement(message) {
  const students = await getAllStudents();
  const notif = { message, date: new Date().toISOString(), read: false };
  await Promise.all(students.map(s =>
    db.collection("students").doc(s.uid).update({
      notifications: firebase.firestore.FieldValue.arrayUnion(notif)
    })
  ));
  return students.length;
}

// الأدمن بيحط خصم خاص لطالب معيّن على دورة معيّنة (أو "*" لكل الدورات)
// بيتطبق أوتوماتيك وقت التسجيل - بياخد الأكبر بينه وبين خصم المستوى العادي
async function setSpecialDiscount(studentUid, courseName, discountPercent) {
  const discount = { courseName, discountPercent: Number(discountPercent) };
  await db.collection("students").doc(studentUid).update({
    specialDiscounts: firebase.firestore.FieldValue.arrayUnion(discount)
  });
}

// الأدمن بيشيل خصم خاص كان حاططه لطالب
async function removeSpecialDiscount(studentUid, courseName, discountPercent) {
  const discount = { courseName, discountPercent: Number(discountPercent) };
  await db.collection("students").doc(studentUid).update({
    specialDiscounts: firebase.firestore.FieldValue.arrayRemove(discount)
  });
}

// الأدمن بيضيف نقاط يدوياً (فيدباك / ريفيو فيسبوك / ريفيو غوغل / إحالة / يدوي)
// بيبعت إشعار بالنقاط، وإشعار إضافي إذا صعد الطالب مستوى بسبب هالنقاط
async function addPointsToStudent(studentUid, points, note) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  const before = doc.data().points || 0;
  const beforeLevel = computeLevel(before);

  await ref.update({ points: firebase.firestore.FieldValue.increment(points) });

  const afterLevel = computeLevel(before + points);
  await addNotification(studentUid, `⭐ حصلت على ${points} نقطة إضافية!`);
  if (afterLevel.name !== beforeLevel.name) {
    await addNotification(studentUid, `🎉 مبروك! وصلت لمستوى ${afterLevel.nameAr}!`);
  }
}

// الأدمن بيغيّر حالة دورة الطالب لـ completed - وهون بالضبط بتنضاف النقاط لرصيد الطالب لأول مرة
// بيبعت إشعار بإتمام الدورة، وإشعار ترقية مستوى إذا صار
async function markEnrollmentStatus(studentUid, enrollmentId, newStatus) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  const existing = doc.data().enrollments || [];
  const beforePoints = doc.data().points || 0;
  let pointsToAward = 0;
  let completedCourseName = "";

  const enrollments = existing.map(en => {
    if ((en.id || en.date) === enrollmentId) {
      // منضيف النقاط بس أول مرة توصل الحالة completed (مش كل مرة تنكبس الزر)
      if (newStatus === "completed" && en.status !== "completed") {
        pointsToAward = en.pointsEarned || 0;
        completedCourseName = en.courseName;
      }
      return { ...en, status: newStatus };
    }
    return en;
  });

  const updates = { enrollments };
  if (pointsToAward > 0) {
    updates.points = firebase.firestore.FieldValue.increment(pointsToAward);
  }
  await ref.update(updates);

  if (completedCourseName) {
    await addNotification(studentUid, `✅ تم اعتماد إتمامك لدورة "${completedCourseName}"!`);
    const afterLevel = computeLevel(beforePoints + pointsToAward);
    const beforeLevel = computeLevel(beforePoints);
    if (afterLevel.name !== beforeLevel.name) {
      await addNotification(studentUid, `🎉 مبروك! وصلت لمستوى ${afterLevel.nameAr}!`);
    }
  }
}

// الطالب بيلغي تسجيله بحاله - بس مسموح إذا لسا الحالة "pending" (ما وافق عليها الأدمن بعد)
async function cancelEnrollment(enrollmentId) {
  const user = auth.currentUser;
  if (!user) throw new Error("NOT_LOGGED_IN");

  const ref = db.collection("students").doc(user.uid);
  const doc = await ref.get();
  const enrollments = doc.data().enrollments || [];
  const target = enrollments.find(en => (en.id || en.date) === enrollmentId);

  if (!target) throw new Error("NOT_FOUND");
  if (target.status !== "pending") throw new Error("CANNOT_CANCEL");

  const remaining = enrollments.filter(en => (en.id || en.date) !== enrollmentId);
  const updates = { enrollments: remaining };
  // ملاحظة: ما منرجع نقاط هون - النقاط أصلاً ما بتنضاف إلا لما الدورة توصل completed
  if (target.discountApplied === 100) {
    updates.freeCourseUsedYear = firebase.firestore.FieldValue.delete();
  }
  await ref.set(updates, { merge: true });
}

// الأدمن بيوافق على تسجيل قيد الموافقة -> بتصير "upcoming" وما تعود تنلغى من الطالب
async function approveEnrollment(studentUid, enrollmentId) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  let courseName = "";
  const enrollments = (doc.data().enrollments || []).map(en => {
    if ((en.id || en.date) === enrollmentId && en.status === "pending") {
      courseName = en.courseName;
      return { ...en, status: "upcoming" };
    }
    return en;
  });
  await ref.update({ enrollments });
  if (courseName) {
    await addNotification(studentUid, `✅ تم تأكيد تسجيلك بدورة "${courseName}"!`);
  }
}

// الأدمن بيلغي/يشيل تسجيل دورة - بيشتغل على أي حالة (pending/upcoming/completed)
// مو بس الـ pending - هيك فيك تلغي دورة لطالب حتى لو كانت متأكدة أو مكتملة أصلاً
async function adminCancelEnrollment(studentUid, enrollmentId) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  const enrollments = doc.data().enrollments || [];
  const target = enrollments.find(en => (en.id || en.date) === enrollmentId);
  if (!target) return;

  const remaining = enrollments.filter(en => (en.id || en.date) !== enrollmentId);
  const updates = { enrollments: remaining };
  if (target.status === "completed") {
    updates.points = firebase.firestore.FieldValue.increment(-(target.pointsEarned || 0));
  }
  if (target.discountApplied === 100) {
    updates.freeCourseUsedYear = firebase.firestore.FieldValue.delete();
  }
  await ref.set(updates, { merge: true });

  const msg = target.status === "pending"
    ? `❌ للأسف لم تتم الموافقة على تسجيلك بدورة "${target.courseName}". تواصل معنا لمزيد من التفاصيل.`
    : `⚠️ تم إلغاء تسجيلك بدورة "${target.courseName}". تواصل معنا لمزيد من التفاصيل.`;
  await addNotification(studentUid, msg);
}

// الأدمن بيضيف/يعدّل ملاحظة على دورة معينة - بتبين للطالب نفسه بحسابه (مش سرّية)
// مثلاً: "يرجى تسليم المشروع الأخير للحصول على الشهادة"
async function setEnrollmentNote(studentUid, enrollmentId, note) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  let courseName = "";
  const enrollments = (doc.data().enrollments || []).map(en => {
    if ((en.id || en.date) === enrollmentId) {
      courseName = en.courseName;
      return { ...en, adminNote: note };
    }
    return en;
  });
  await ref.update({ enrollments });

  if (note && courseName) {
    await addNotification(studentUid, `📝 ملاحظة جديدة على دورة "${courseName}": ${note}`);
  }
}

// الأدمن بيضيف دورة قديمة يدوياً لحساب طالب (لسجل دوراته من قبل ما ينضاف هالنظام)
// بتاخد نقاط بس إذا حالتها "completed" (نفس قاعدة أي دورة تانية)
async function addManualEnrollment(studentUid, { courseName, type, finalPrice, status, date }) {
  const pointsEarned = Math.round((finalPrice || 0) * POINTS_PER_DOLLAR);
  const finalStatus = status || "completed";

  const enrollment = {
    id: generateEnrollmentId(),
    courseName,
    type: type || "group",
    basePrice: finalPrice,
    discountApplied: 0,
    finalPrice: finalPrice,
    pointsEarned,
    status: finalStatus,
    date: date ? new Date(date).toISOString() : new Date().toISOString(),
    manuallyAdded: true
  };

  const updates = { enrollments: firebase.firestore.FieldValue.arrayUnion(enrollment) };
  if (finalStatus === "completed") {
    updates.points = firebase.firestore.FieldValue.increment(pointsEarned);
  }
  await db.collection("students").doc(studentUid).set(updates, { merge: true });
}

// الأدمن بيضيف رابط شهادة لحساب الطالب (رابط جاهز من Google Drive أو أي مكان تاني)
async function addCertificateToStudent(studentUid, { courseName, url }) {
  const cert = {
    courseName,
    url,
    dateIssued: new Date().toISOString()
  };
  await db.collection("students").doc(studentUid).update({
    certificates: firebase.firestore.FieldValue.arrayUnion(cert)
  });
  await addNotification(studentUid, `🎓 شهادتك لدورة "${courseName}" جاهزة! افتح حسابك لتحميلها.`);
}

// الأدمن بيغيّر رقم طالب يدوياً (مثلاً زبون قديم، وبدك رقمه يعكس سنة أول دورة اخدها فعلياً)
async function setStudentId(studentUid, oldId, newId) {
  const studentRef = db.collection("students").doc(studentUid);
  const doc = await studentRef.get();
  const email = doc.data().email;

  await studentRef.update({ studentId: newId });
  await db.collection("studentIdLookup").doc(newId).set({ email, uid: studentUid });
  if (oldId && oldId !== newId) {
    await db.collection("studentIdLookup").doc(oldId).delete();
  }
}

// الأدمن بيعدّل بيانات عرض الطالب (الاسم، الإيميل المعروض، الهاتف، الجنس، تاريخ الميلاد)
// ملاحظة: هاد بيعدّل بيانات العرض بقاعدة البيانات بس - ما بيغيّر إيميل/باسوورد الدخول الفعلي
// (هيك محمي من Firebase نفسها، وما فينا نلمسه من غير سيرفر خلفي)
async function editStudentProfile(studentUid, { name, phone, gender, birthDate }) {
  await db.collection("students").doc(studentUid).update({
    name, phone, gender, birthDate
  });
}

// ==========================================================
// فحص إذا الإيميل مسجل عندنا فعلاً - قبل ما نرسل أي شي
// (Firebase نفسه ما بيكشف هالمعلومة لأسباب أمان، فمنفحصها إحنا بقاعدة بياناتنا)
// ==========================================================
async function checkEmailRegistered(email) {
  const snap = await db.collection("studentIdLookup").where("email", "==", email).limit(1).get();
  return !snap.empty;
}

// ==========================================================
// نسيان كلمة السر - الرابط بيوديك مباشرة على reset-password.html بموقعنا
// (handleCodeInApp: true بيلغي صفحة Firebase الوسيطة تماماً)
// ==========================================================
async function requestPasswordReset(email) {
  const resetUrl = window.location.origin + window.location.pathname.replace(/[^/]*$/, '') + 'reset-password.html';
  await auth.sendPasswordResetEmail(email, { url: resetUrl, handleCodeInApp: true });
}

// ==========================================================
// تغيير كلمة السر - للطالب المسجل دخول مسبقاً، بدون أي إيميل
// ==========================================================
async function changeMyPassword(currentPassword, newPassword) {
  const user = auth.currentUser;
  if (!user) throw new Error("NOT_LOGGED_IN");

  // Firebase بيطلب إعادة تأكيد الهوية قبل تغيير كلمة السر (إجراء أمان)
  const credential = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
  await user.reauthenticateWithCredential(credential);
  await user.updatePassword(newPassword);
}

// ==========================================================
// نقل بيانات طالب نسي كلمة سره لحساب جديد (بدون أي إيميل تلقائي)
// السيناريو: الطالب رجعك بالواتساب -> بتمسحله حسابه القديم من Firebase Console
// -> بيعمل حساب جديد بنفس إيميله وباسوورد يختاره -> بتستخدم هاي الدالة تنقل
// كل تاريخه (نقاط/دورات/رقمه/شهادات/إشعارات) من الحساب القديم اليتيم للحساب الجديد
// newIdentifier: إيميل أو رقم طالب (Student ID) تبع الحساب الجديد
// ==========================================================
async function migrateStudentData(oldUid, newIdentifier) {
  let newUid = null;
  const identifier = (newIdentifier || "").trim();

  if (identifier.includes("@")) {
    const snap = await db.collection("students").where("email", "==", identifier).limit(1).get();
    if (!snap.empty) newUid = snap.docs[0].id;
  } else {
    const lookupDoc = await db.collection("studentIdLookup").doc(identifier).get();
    if (lookupDoc.exists) newUid = lookupDoc.data().uid;
  }

  if (!newUid) throw new Error("NEW_ACCOUNT_NOT_FOUND");
  if (newUid === oldUid) throw new Error("SAME_ACCOUNT");

  const oldRef = db.collection("students").doc(oldUid);
  const oldDoc = await oldRef.get();
  if (!oldDoc.exists) throw new Error("OLD_ACCOUNT_NOT_FOUND");
  const oldData = oldDoc.data();

  const newRef = db.collection("students").doc(newUid);
  const newDoc = await newRef.get();
  const newData = newDoc.data() || {};

  const mergedEnrollments = [...(oldData.enrollments || []), ...(newData.enrollments || [])];
  const mergedCertificates = [...(oldData.certificates || []), ...(newData.certificates || [])];
  const mergedNotifications = [...(oldData.notifications || []), ...(newData.notifications || [])];
  const mergedPoints = (oldData.points || 0) + (newData.points || 0);
  const keepStudentId = oldData.studentId || newData.studentId;

  await newRef.set({
    enrollments: mergedEnrollments,
    certificates: mergedCertificates,
    notifications: mergedNotifications,
    points: mergedPoints,
    studentId: keepStudentId,
    gender: newData.gender || oldData.gender || "",
    birthDate: newData.birthDate || oldData.birthDate || ""
  }, { merge: true });

  // حدّث خريطة رقم الطالب تشاور عالحساب الجديد
  if (keepStudentId) {
    await db.collection("studentIdLookup").doc(keepStudentId).set({ email: newData.email, uid: newUid });
  }

  // احذف الحساب القديم اليتيم بعد ما خلص النقل
  await oldRef.delete();

  return { mergedInto: newUid, studentId: keepStudentId };
}
