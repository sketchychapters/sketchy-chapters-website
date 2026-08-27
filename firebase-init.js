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

const POINTS_PER_DOLLAR = 7;

const LEVELS = [
  { name: "Basic",    nameAr: "أساسي",    min: 0,    courseDiscount: 0,  referralDiscount: 0,  birthdayDiscount: 20, freeCourseYearly: false },
  { name: "Classic",  nameAr: "كلاسيك",   min: 1000, courseDiscount: 10, referralDiscount: 5,  birthdayDiscount: 30, freeCourseYearly: false },
  { name: "Gold",     nameAr: "ذهبي",     min: 2500, courseDiscount: 15, referralDiscount: 10, birthdayDiscount: 40, freeCourseYearly: false },
  { name: "Platinum", nameAr: "بلاتيني",  min: 5000, courseDiscount: 20, referralDiscount: 15, birthdayDiscount: 50, freeCourseYearly: true  }
];

const COURSE_PREREQUISITES = {
  "Revit Architecture Advanced + V-Ray": ["Revit Architecture"]
};

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

function computeLevel(points) {
  points = points || 0;
  let current = LEVELS[0];
  for (const lvl of LEVELS) {
    if (points >= lvl.min) current = lvl;
  }
  return current;
}

function nextLevel(points) {
  points = points || 0;
  for (const lvl of LEVELS) {
    if (points < lvl.min) return lvl;
  }
  return null; // وصل لأعلى مستوى
}

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

async function signUpStudent({ name, email, password, birthDate, phone, gender, referredBy, country, region, specialization }) {
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
    region: region || "",
    specialization: specialization || "",
    referredBy: referredBy || "",   // studentId تبع اللي حولّه (اختياري)
    points: 0,
    freeCourseUsedYear: null,       // آخر سنة استخدم فيها الكورس المجاني (Platinum)
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    enrollments: []
  });

  await db.collection("studentIdLookup").doc(studentId).set({ email, uid });

  return uid;
}

async function loginStudent(identifier, password) {
  let email = (identifier || "").trim();

  if (!email.includes("@")) {
    const lookupDoc = await db.collection("studentIdLookup").doc(email).get();
    if (!lookupDoc.exists) throw new Error("STUDENT_ID_NOT_FOUND");
    email = lookupDoc.data().email;
  }

  const cred = await auth.signInWithEmailAndPassword(email, password);
  return cred.user.uid;
}

function logoutStudent() {
  try { localStorage.removeItem('sketchy_cart'); } catch (e) {}
  return auth.signOut();
}

async function getCurrentStudentData() {
  const user = auth.currentUser;
  if (!user) return null;
  const doc = await db.collection("students").doc(user.uid).get();
  return doc.exists ? { uid: user.uid, ...doc.data() } : null;
}

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

function isBirthdayWeek(birthDateStr) {
  if (!birthDateStr) return false;
  const today = new Date();
  const bd = new Date(birthDateStr);
  const birthdayThisYear = new Date(today.getFullYear(), bd.getMonth(), bd.getDate());
  const diffDays = Math.abs((birthdayThisYear - today) / (1000 * 60 * 60 * 24));
  return diffDays <= 7;
}

async function enrollInCourse({ courseName, basePrice, type, noDiscount, redeemFreeCourse }) {
  const user = auth.currentUser;
  if (!user) {
    window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.pathname);
    return;
  }

  const studentData = await getCurrentStudentData();
  if (!studentData) {
    throw new Error("PROFILE_MISSING");
  }

  const existingEnrollments = studentData.enrollments || [];
  const alreadyActive = existingEnrollments.some(
    en => en.courseName === courseName && en.status !== "completed" && en.status !== "cancelled"
  );
  if (alreadyActive) {
    throw new Error("ALREADY_ENROLLED");
  }

  const level = computeLevel(studentData.points);

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

  const updates = {
    enrollments: firebase.firestore.FieldValue.arrayUnion(enrollment)
  };
  if (usedFreeCourse) updates.freeCourseUsedYear = thisYear;

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
  let birthdayDiscountUsedThisSubmission = false;

  const hasEnrollmentHistory = existingEnrollments.length > 0;

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
      const canUseBirthdayDiscount =
        !noDiscount &&
        hasEnrollmentHistory &&
        isBirthdayWeek(studentData.birthDate) &&
        studentData.birthdayDiscountUsedYear !== thisYear &&
        !birthdayDiscountUsedThisSubmission;

      if (canUseBirthdayDiscount) {
        bestDiscount = Math.max(bestDiscount, level.birthdayDiscount);
        birthdayDiscountUsedThisSubmission = true; // بيتطبق على دورة وحدة بس من كل السلة
      }
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
  if (birthdayDiscountUsedThisSubmission) updates.birthdayDiscountUsedYear = thisYear;

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

async function addNotification(studentUid, message) {
  const notif = {
    id: generateEnrollmentId(),
    message,
    date: new Date().toISOString(),
    read: false
  };
  await db.collection("students").doc(studentUid).update({
    notifications: firebase.firestore.FieldValue.arrayUnion(notif)
  });
}

async function deleteNotification(studentUid, notifId) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  const notifications = (doc.data().notifications || []).filter(n => (n.id || n.date) !== notifId);
  await ref.update({ notifications });
}

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

const REFERRAL_BONUS_POINTS = 200;

async function submitReferralClaim(identifier) {
  const user = auth.currentUser;
  if (!user) throw new Error("NOT_LOGGED_IN");

  const myData = await getCurrentStudentData();
  const mine = [myData?.name, myData?.email, myData?.phone, myData?.studentId]
    .filter(Boolean).map(v => v.toLowerCase().trim());
  if (mine.includes(identifier.toLowerCase().trim())) {
    throw new Error("SELF_REFERRAL");
  }

  const claim = {
    inputText: identifier,
    status: "pending", // pending -> awarded/dismissed (بعد ما الأدمن يفحصها يدوياً)
    date: new Date().toISOString()
  };

  await db.collection("students").doc(user.uid).update({ referralClaim: claim });
  return claim;
}

async function awardReferralPoints(referredStudentUid, referrerUid, referrerName) {
  await addPointsToStudent(referrerUid, REFERRAL_BONUS_POINTS, "referral");

  const ref = db.collection("students").doc(referredStudentUid);
  const doc = await ref.get();
  const claim = doc.data().referralClaim || {};
  await ref.update({ referralClaim: { ...claim, status: "awarded", awardedTo: referrerName } });
}

async function editReferralClaimText(studentUid, newText) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  const claim = doc.data().referralClaim || {};
  await ref.update({ referralClaim: { ...claim, inputText: newText } });
}

async function checkAndNotifyBirthday() {
  const user = auth.currentUser;
  if (!user) return;
  const data = await getCurrentStudentData();
  if (!data || !data.birthDate) return;
  if (!isBirthdayWeek(data.birthDate)) return;

  const thisYear = new Date().getFullYear();
  if (data.lastBirthdayNotifiedYear === thisYear) return;

  const level = computeLevel(data.points || 0);
  const hasEnrollmentHistory = (data.enrollments || []).length > 0;
  const alreadyUsedDiscount = data.birthdayDiscountUsedYear === thisYear;

  const message = (hasEnrollmentHistory && !alreadyUsedDiscount)
    ? `🎂 عيد ميلاد سعيد! يحق لك الحصول على خصم خاص ${level.birthdayDiscount}% على دورة واحدة هذا الأسبوع.`
    : `🎂 عيد ميلاد سعيد من فريق Sketchy Chapters! نتمنى لك سنة رائعة.`;

  await addNotification(user.uid, message);
  await db.collection("students").doc(user.uid).update({ lastBirthdayNotifiedYear: thisYear });
}

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

async function setSpecialDiscount(studentUid, courseName, discountPercent) {
  const discount = { courseName, discountPercent: Number(discountPercent) };
  await db.collection("students").doc(studentUid).update({
    specialDiscounts: firebase.firestore.FieldValue.arrayUnion(discount)
  });
}

async function removeSpecialDiscount(studentUid, courseName, discountPercent) {
  const discount = { courseName, discountPercent: Number(discountPercent) };
  await db.collection("students").doc(studentUid).update({
    specialDiscounts: firebase.firestore.FieldValue.arrayRemove(discount)
  });
}

async function logPointsChange(studentUid, points, reason) {
  const entry = { id: generateEnrollmentId(), points, reason, date: new Date().toISOString() };
  await db.collection("students").doc(studentUid).update({
    pointsLog: firebase.firestore.FieldValue.arrayUnion(entry)
  });
}

async function editPointsLogEntry(studentUid, entryId, newPoints, newReason) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  const log = doc.data().pointsLog || [];
  const target = log.find(e => (e.id || e.date) === entryId);
  if (!target) return;

  const diff = newPoints - target.points;
  const updatedLog = log.map(e =>
    (e.id || e.date) === entryId ? { ...e, points: newPoints, reason: newReason } : e
  );

  await ref.update({
    pointsLog: updatedLog,
    points: firebase.firestore.FieldValue.increment(diff)
  });
}

async function deletePointsLogEntry(studentUid, entryId) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  const log = doc.data().pointsLog || [];
  const target = log.find(e => (e.id || e.date) === entryId);
  if (!target) return;

  const remainingLog = log.filter(e => (e.id || e.date) !== entryId);

  await ref.update({
    pointsLog: remainingLog,
    points: firebase.firestore.FieldValue.increment(-target.points)
  });
}

async function addPointsToStudent(studentUid, points, note) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  const before = doc.data().points || 0;
  const beforeLevel = computeLevel(before);

  await ref.update({ points: firebase.firestore.FieldValue.increment(points) });
  await logPointsChange(studentUid, points, note || "manual");

  const afterLevel = computeLevel(before + points);
  await addNotification(studentUid, `⭐ حصلت على ${points} نقطة إضافية!`);
  if (afterLevel.name !== beforeLevel.name) {
    await addNotification(studentUid, `🎉 مبروك! وصلت لمستوى ${afterLevel.nameAr}!`);
  }
}

async function markEnrollmentStatus(studentUid, enrollmentId, newStatus) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  const existing = doc.data().enrollments || [];
  const beforePoints = doc.data().points || 0;
  let pointsToAward = 0;
  let completedCourseName = "";

  const enrollments = existing.map(en => {
    if ((en.id || en.date) === enrollmentId) {
      if (newStatus === "completed" && en.status !== "completed") {
        pointsToAward = en.pointsEarned || 0;
        completedCourseName = en.courseName;
      }
      const autoEndDate = (newStatus === "completed" && !en.endDate)
        ? new Date().toISOString().slice(0, 10)
        : en.endDate;
      return { ...en, status: newStatus, endDate: autoEndDate };
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
    if (pointsToAward > 0) {
      await logPointsChange(studentUid, pointsToAward, `Course completed: ${completedCourseName}`);
    }
    const afterLevel = computeLevel(beforePoints + pointsToAward);
    const beforeLevel = computeLevel(beforePoints);
    if (afterLevel.name !== beforeLevel.name) {
      await addNotification(studentUid, `🎉 مبروك! وصلت لمستوى ${afterLevel.nameAr}!`);
    }
  }
}

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
  if (target.discountApplied === 100) {
    updates.freeCourseUsedYear = firebase.firestore.FieldValue.delete();
  }
  await ref.set(updates, { merge: true });
}

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

async function setEnrollmentSchedule(studentUid, enrollmentId, startDate, endDate) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  let courseName = "";
  const enrollments = (doc.data().enrollments || []).map(en => {
    if ((en.id || en.date) === enrollmentId) {
      courseName = en.courseName;
      return { ...en, startDate: startDate || "", endDate: endDate || "" };
    }
    return en;
  });
  await ref.update({ enrollments });

  if (courseName && (startDate || endDate)) {
    await addNotification(studentUid, `📅 تم تحديث موعد دورة "${courseName}"${startDate ? ` — تبدأ ${startDate}` : ""}${endDate ? ` وتنتهي ${endDate}` : ""}.`);
  }
}

async function addManualEnrollment(studentUid, { courseName, type, finalPrice, status, date, startDate, endDate }) {
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
    startDate: startDate || "",
    endDate: endDate || "",
    manuallyAdded: true
  };

  const updates = { enrollments: firebase.firestore.FieldValue.arrayUnion(enrollment) };
  if (finalStatus === "completed") {
    updates.points = firebase.firestore.FieldValue.increment(pointsEarned);
  }
  await db.collection("students").doc(studentUid).set(updates, { merge: true });
}

async function editEnrollmentDetails(studentUid, enrollmentId, { courseName, type, finalPrice }) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  let pointsDiff = 0;

  const enrollments = (doc.data().enrollments || []).map(en => {
    if ((en.id || en.date) === enrollmentId) {
      const newPointsEarned = Math.round((finalPrice || 0) * POINTS_PER_DOLLAR);
      if (en.status === "completed") {
        pointsDiff = newPointsEarned - (en.pointsEarned || 0);
      }
      return { ...en, courseName, type, basePrice: finalPrice, finalPrice, pointsEarned: newPointsEarned };
    }
    return en;
  });

  const updates = { enrollments };
  if (pointsDiff !== 0) {
    updates.points = firebase.firestore.FieldValue.increment(pointsDiff);
  }
  await ref.update(updates);
}

async function addCertificateToStudent(studentUid, { courseName, url }) {
  const cert = {
    id: generateEnrollmentId(), // نفس مولّد المعرّفات، صالح لأي شي محتاج ID فريد
    courseName,
    url,
    dateIssued: new Date().toISOString()
  };
  await db.collection("students").doc(studentUid).update({
    certificates: firebase.firestore.FieldValue.arrayUnion(cert)
  });
  await addNotification(studentUid, `🎓 شهادتك لدورة "${courseName}" جاهزة! افتح حسابك لتحميلها.`);
}

async function editCertificate(studentUid, certId, { courseName, url }) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  const certificates = (doc.data().certificates || []).map(c =>
    (c.id || c.url) === certId ? { ...c, courseName, url } : c
  );
  await ref.update({ certificates });
}

async function deleteCertificate(studentUid, certId) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  const certificates = (doc.data().certificates || []).filter(c => (c.id || c.url) !== certId);
  await ref.update({ certificates });
}

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

async function deleteStudentRecord(studentUid, studentId) {
  await db.collection("students").doc(studentUid).delete();
  if (studentId) {
    await db.collection("studentIdLookup").doc(studentId).delete();
  }
}

async function editStudentProfile(studentUid, { name, phone, gender, birthDate, specialization, country, region }) {
  await db.collection("students").doc(studentUid).update({
    name, phone, gender, birthDate, specialization, country, region
  });
}

async function checkEmailRegistered(email) {
  const snap = await db.collection("studentIdLookup").where("email", "==", email).limit(1).get();
  return !snap.empty;
}

async function requestPasswordReset(email) {
  const resetUrl = window.location.origin + window.location.pathname.replace(/[^/]*$/, '') + 'reset-password.html';
  await auth.sendPasswordResetEmail(email, { url: resetUrl, handleCodeInApp: true });
}

async function changeMyPassword(currentPassword, newPassword) {
  const user = auth.currentUser;
  if (!user) throw new Error("NOT_LOGGED_IN");

  const credential = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
  await user.reauthenticateWithCredential(credential);
  await user.updatePassword(newPassword);
}

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

  if (keepStudentId) {
    await db.collection("studentIdLookup").doc(keepStudentId).set({ email: newData.email, uid: newUid });
  }

  await oldRef.delete();

  return { mergedInto: newUid, studentId: keepStudentId };
}

function injectDialogSystem() {
  if (document.getElementById("customDialogModal")) return;
  const modal = document.createElement("div");
  modal.id = "customDialogModal";
  modal.className = "hidden fixed inset-0 bg-black/80 flex items-center justify-center px-6";
  modal.style.zIndex = "9998";
  modal.innerHTML = `
    <div style="background:#121216;border:1px solid rgba(212,175,55,.4);border-radius:24px;padding:32px;max-width:24rem;width:100%;">
      <p id="customDialogMessage" style="color:#fff;font-size:14px;margin-bottom:20px;white-space:pre-line;line-height:1.6;"></p>
      <input id="customDialogInput" type="text" class="hidden" style="width:100%;background:rgba(0,0,0,.4);border:1px solid rgba(212,175,55,.25);color:#fff;border-radius:12px;padding:10px 16px;font-size:14px;margin-bottom:16px;">
      <div id="customDialogButtons" style="display:flex;gap:12px;"></div>
    </div>
  `;
  document.body.appendChild(modal);
}

function closeCustomDialog() {
  const modal = document.getElementById("customDialogModal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
}

function customAlert(message) {
  injectDialogSystem();
  return new Promise(resolve => {
    document.getElementById("customDialogMessage").textContent = message;
    document.getElementById("customDialogInput").classList.add("hidden");
    document.getElementById("customDialogButtons").innerHTML =
      '<button id="dlgOk" style="flex:1;background:linear-gradient(135deg,#d4af37,#aa7c11);color:#000;font-weight:700;padding:10px;border-radius:12px;font-size:13px;">OK</button>';
    const modal = document.getElementById("customDialogModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    document.getElementById("dlgOk").onclick = () => { closeCustomDialog(); resolve(); };
  });
}

function customConfirm(message) {
  injectDialogSystem();
  return new Promise(resolve => {
    document.getElementById("customDialogMessage").textContent = message;
    document.getElementById("customDialogInput").classList.add("hidden");
    document.getElementById("customDialogButtons").innerHTML = `
      <button id="dlgYes" style="flex:1;background:linear-gradient(135deg,#d4af37,#aa7c11);color:#000;font-weight:700;padding:10px;border-radius:12px;font-size:13px;">Yes</button>
      <button id="dlgNo" style="flex:1;background:rgba(18,18,22,.65);border:1px solid #374151;color:#9ca3af;font-weight:700;padding:10px;border-radius:12px;font-size:13px;">Cancel</button>
    `;
    const modal = document.getElementById("customDialogModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    document.getElementById("dlgYes").onclick = () => { closeCustomDialog(); resolve(true); };
    document.getElementById("dlgNo").onclick = () => { closeCustomDialog(); resolve(false); };
  });
}

function customPrompt(message, defaultValue) {
  injectDialogSystem();
  return new Promise(resolve => {
    document.getElementById("customDialogMessage").textContent = message;
    const input = document.getElementById("customDialogInput");
    input.classList.remove("hidden");
    input.value = defaultValue || "";
    document.getElementById("customDialogButtons").innerHTML = `
      <button id="dlgPOk" style="flex:1;background:linear-gradient(135deg,#d4af37,#aa7c11);color:#000;font-weight:700;padding:10px;border-radius:12px;font-size:13px;">OK</button>
      <button id="dlgPCancel" style="flex:1;background:rgba(18,18,22,.65);border:1px solid #374151;color:#9ca3af;font-weight:700;padding:10px;border-radius:12px;font-size:13px;">Cancel</button>
    `;
    const modal = document.getElementById("customDialogModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    document.getElementById("dlgPOk").onclick = () => { const v = input.value; closeCustomDialog(); resolve(v); };
    document.getElementById("dlgPCancel").onclick = () => { closeCustomDialog(); resolve(null); };
  });
}

// ==========================================================
// "My Library" — روابط يضيفها الأدمن يدوياً لأي طالب (عنوان + رابط تحميل)
// نفس نمط الشهادات بالضبط، بس تحت اسم "resources" وبدون شرط تلقائي
// ==========================================================

async function addResourceToStudent(studentUid, { title, url }) {
  const resourceId = generateEnrollmentId() + "-" + generateEnrollmentId();
  const ref = db.collection("students").doc(studentUid);
  await ref.update({
    resources: firebase.firestore.FieldValue.arrayUnion({
      id: resourceId,
      title: title,
      url: url,
      dateAdded: new Date().toISOString()
    })
  });
  return resourceId;
}

async function editResource(studentUid, resourceId, { title, url }) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  if (!doc.exists) return;
  const data = doc.data();
  const resources = (data.resources || []).map(r =>
    (r.id === resourceId) ? { ...r, title, url } : r
  );
  await ref.update({ resources });
}

async function deleteResource(studentUid, resourceId) {
  const ref = db.collection("students").doc(studentUid);
  const doc = await ref.get();
  if (!doc.exists) return;
  const data = doc.data();
  const resources = (data.resources || []).filter(r => r.id !== resourceId);
  await ref.update({ resources });
}
