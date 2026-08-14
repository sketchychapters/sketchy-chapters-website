// ==========================================================
// booking-ui.js
// منطق "سلة الاختيارات" (Cart) + أنيميشن القبعة الطايرة
// الطالب بيضيف كل الكورسات يلي بده ياها، ويقدر يشيل ويزيد،
// وبس يدوس "تأكيد وإرسال التسجيل" بينكتبوا كلهم وبيبعت إيميل واحد فيه القائمة كاملة
// حط هاد السكربت + firebase-init.js + course-booking.js بكل صفحة فيها زر تسجيل بدورة
// ==========================================================

let currentBooking = null;
let cart = [];
try { cart = JSON.parse(localStorage.getItem('sketchy_cart') || '[]'); } catch (e) { cart = []; }

// نستنى Firebase يتأكد فعلياً من حالة تسجيل الدخول قبل ما نسمح/نمنع الحجز
let authReadyPromise = new Promise(resolve => {
  const unsub = auth.onAuthStateChanged(user => { unsub(); resolve(user); });
});

async function openBookingModal(courseName, basePrice) {
  const user = await authReadyPromise;
  if (!user || !auth.currentUser) {
    console.warn('openBookingModal: no authenticated user, redirecting to login.', { user, current: auth.currentUser });
    window.location.href = 'login.html?redirect=' + encodeURIComponent(window.location.pathname);
    return;
  }
  currentBooking = { courseName, basePrice };
  document.getElementById('modalCourseName').innerText = courseName;

  // نجيب بيانات الطالب مرة وحدة، ومنستخدمها لعرض السعر الفعلي (بعد خصم مستواه/عيد ميلاده) وزر الكورس المجاني
  getCurrentStudentData().then(data => {
    if (!data) return;
    const level = computeLevel(data.points);

    // زر الكورس المجاني للبلاتيني (إذا موجود بالصفحة ولسا ما استخدمه هالسنة)
    const freeBtn = document.getElementById('redeemFreeCourseBtn');
    if (freeBtn) {
      const thisYear = new Date().getFullYear();
      const canRedeem = level.freeCourseYearly && data.freeCourseUsedYear !== thisYear;
      freeBtn.classList.toggle('hidden', !canRedeem);
    }

    // نعرض السعر الفعلي (بعد الخصم) بدل السعر الأساسي، عشان الطالب يشوف صح قبل ما يأكد
    let bestDiscount = level.courseDiscount;
    const thisYearForBday = new Date().getFullYear();
    const hasEnrollmentHistory = (data.enrollments || []).length > 0;
    const canUseBirthdayDiscount =
      window.DISABLE_BIRTHDAY_DISCOUNT !== true &&
      hasEnrollmentHistory &&
      isBirthdayWeek(data.birthDate) &&
      data.birthdayDiscountUsedYear !== thisYearForBday;
    if (canUseBirthdayDiscount) {
      bestDiscount = Math.max(bestDiscount, level.birthdayDiscount);
    }
    renderBookingPriceHint(basePrice, bestDiscount);
  });

  document.getElementById('bookingModal').classList.remove('hidden');
  document.getElementById('bookingModal').classList.add('flex');
}

// شريط صغير بمودال الحجز يبيّن السعر الفعلي بعد أي خصم مستحق (مستوى الطالب أو أسبوع عيد ميلاده)
function renderBookingPriceHint(basePrice, discountPercent) {
  const modalBox = document.querySelector('#bookingModal > div');
  if (!modalBox) return;

  let hint = document.getElementById('bookingPriceHint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'bookingPriceHint';
    hint.className = 'rounded-xl p-3 mb-4 text-xs text-center border';
    const titleEl = document.getElementById('modalCourseName');
    if (titleEl && titleEl.parentElement) {
      titleEl.insertAdjacentElement('afterend', hint);
    } else {
      modalBox.insertBefore(hint, modalBox.firstChild);
    }
  }

  if (discountPercent > 0) {
    const finalPrice = Math.round((basePrice - (basePrice * discountPercent / 100)) * 100) / 100;
    hint.className = 'rounded-xl p-3 mb-4 text-xs text-center border border-amber-500/30 bg-amber-500/10 text-amber-300';
    hint.innerHTML = `💰 Your price: <strong>$${finalPrice}</strong> <span class="text-emerald-400">(${discountPercent}% off $${basePrice})</span>`;
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
  }
}

function closeBookingModal() {
  document.getElementById('bookingModal').classList.add('hidden');
  document.getElementById('bookingModal').classList.remove('flex');
}

// دوس Group/Private/Free بمودال الكورس -> منضيف للسلة، ما منسجل فوراً وما منبعت إيميل هلق
// إضافة باقة صيفية (Package) للسلة - يا الباقة كاملة يا ولا شي، ممنوع تنضاف ناقصة
async function addPackageToCart(courseNames, totalPrice, event) {
  const user = await authReadyPromise;
  if (!user || !auth.currentUser) {
    window.location.href = 'login.html?redirect=' + encodeURIComponent(window.location.pathname);
    return;
  }

  const btn = event ? (event.currentTarget || event.target.closest('button')) : null;
  let originX = null, originY = null;
  if (event && event.clientX) { originX = event.clientX; originY = event.clientY; }
  if (btn) btn.classList.add('tilt-throw');

  try {
    const data = await getCurrentStudentData();
    const existingEnrollments = (data && data.enrollments) || [];

    // نفحص كل دورات الباقة قبل ما نضيف أي شي - لو في تعارض بأي وحدة منهم، الباقة كلها بترفض
    const conflicts = courseNames.filter(courseName =>
      cart.some(item => item.courseName === courseName) ||
      existingEnrollments.some(en => en.courseName === courseName && en.status !== 'cancelled')
    );

    if (conflicts.length > 0) {
      showBookingToast(`⚠️ You already have "${conflicts.join('", "')}" registered. This package can't be split — please register the remaining courses individually, or wait until your existing course is done before taking the full package.`);
      return;
    }

    const perCoursePrice = Math.round((totalPrice / courseNames.length) * 100) / 100;
    for (const courseName of courseNames) {
      cart.push({ courseName, basePrice: perCoursePrice, type: 'group', redeemFreeCourse: false });
    }

    localStorage.setItem('sketchy_cart', JSON.stringify(cart));
    renderCartBadge();
    renderCartItems();
    flyGraduationCapFrom(originX, originY, null, '#cartToggleBtn');
    showBookingToast(`🎓 Package added to your selections (${courseNames.length} courses). Open your cart to review and submit.`);
  } catch (err) {
    console.error('addPackageToCart failed:', err);
    showBookingToast('⚠️ Something went wrong. Please try again.');
  }
}

async function confirmBooking(type, event) {
  const booking = currentBooking;
  const redeemFreeCourse = (type === 'free');
  const bookingType = redeemFreeCourse ? 'group' : type;

  const btn = event ? (event.currentTarget || event.target.closest('button')) : null;
  const capIcon = btn ? btn.querySelector('.mini-cap') : null;
  let originX = null, originY = null;
  if (capIcon) {
    const r = capIcon.getBoundingClientRect();
    originX = r.left + r.width / 2;
    originY = r.top + r.height / 2;
  } else if (event && event.clientX) {
    originX = event.clientX;
    originY = event.clientY;
  }
  if (btn) btn.classList.add('tilt-throw');

  closeBookingModal();

  const alreadyInCart = cart.some(item => item.courseName === booking.courseName);
  if (alreadyInCart) {
    showBookingToast('⚠️ Already in your selections.');
    return;
  }

  // فحص فوري: هل الطالب مؤهل لهاي الدورة (سجّل بالدورة المطلوبة قبلها إذا في وحدة)؟
  try {
    const data = await getCurrentStudentData();
    const prereq = checkPrerequisites(booking.courseName, data ? data.enrollments : [], cart);
    if (!prereq.ok) {
      showBookingToast(`⚠️ You need to register for "${prereq.missing}" before "${booking.courseName}".`);
      return;
    }
  } catch (err) {
    console.error('Prerequisite check failed:', err);
  }

  cart.push({ courseName: booking.courseName, basePrice: booking.basePrice, type: bookingType, redeemFreeCourse });
  localStorage.setItem('sketchy_cart', JSON.stringify(cart));
  renderCartBadge();
  renderCartItems();

  // القبعة الصغيرة تطير هلق عالسلة (مش عالحساب - لسا ما تسجل رسمياً)
  flyGraduationCapFrom(originX, originY, capIcon, '#cartToggleBtn');

  showBookingToast(`🎓 "${booking.courseName}" added to your selections. Open your cart to review and submit.`);
}

// ----------------------------------------------------------
// أنيميشن القبعة: نفس القبعة الصغيرة يلي عالزر هي يلي بتنطلق
// (مسار منحني متل قذيفة مدفع) وبتوصل لهدفها (السلة أو الحساب)
// ----------------------------------------------------------
const GRAD_CAP_SVG = `
<svg width="46" height="46" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <polygon points="32,10 60,24 32,38 4,24" fill="#0b0b0e" stroke="#d4af37" stroke-width="2"/>
  <polygon points="32,10 60,24 32,38 4,24" fill="url(#capGrad)" opacity="0.25"/>
  <path d="M14 28 V42 C14 46 22 50 32 50 C42 50 50 46 50 42 V28 L32 38 Z" fill="#121216" stroke="#d4af37" stroke-width="1.5"/>
  <circle cx="32" cy="24" r="3" fill="#d4af37"/>
  <line x1="55" y1="24" x2="55" y2="42" stroke="#d4af37" stroke-width="1.5"/>
  <circle cx="55" cy="45" r="3.5" fill="#d4af37"/>
  <defs>
    <linearGradient id="capGrad" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
      <stop stop-color="#fcf6ba"/>
      <stop offset="1" stop-color="#d4af37"/>
    </linearGradient>
  </defs>
</svg>`;

// إعداد أنيميشن ميل الزر (يُحقن مرة وحدة بكل صفحة)
(function injectCapStyles() {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes tiltThrow {
      0% { transform: rotate(0deg); }
      25% { transform: rotate(-9deg); }
      55% { transform: rotate(5deg); }
      100% { transform: rotate(0deg); }
    }
    .tilt-throw { animation: tiltThrow 0.4s ease; transform-origin: center; }
  `;
  document.head.appendChild(style);
})();

function flyGraduationCapFrom(startX, startY, sourceIconEl, targetSelector) {
  const target = targetSelector
    ? document.querySelector(targetSelector)
    : (document.querySelector('#authArea a, #authArea button') || document.getElementById('mobileAuthLink'));
  if (!target) return;

  if (startX == null || startY == null) {
    startX = window.innerWidth / 2;
    startY = window.innerHeight * 0.45;
  }

  const rect = target.getBoundingClientRect();
  const endX = rect.left + rect.width / 2;
  const endY = rect.top + rect.height / 2;
  const controlX = (startX + endX) / 2;
  const controlY = Math.min(startY, endY) - 130;

  if (sourceIconEl) sourceIconEl.style.opacity = '0';

  const cap = document.createElement('div');
  cap.innerHTML = GRAD_CAP_SVG;
  Object.assign(cap.style, {
    position: 'fixed',
    left: startX + 'px',
    top: startY + 'px',
    zIndex: '9999',
    pointerEvents: 'none',
    transformOrigin: 'center',
    filter: 'drop-shadow(0 4px 12px rgba(212,175,55,0.55))'
  });
  document.body.appendChild(cap);

  const duration = 700;
  const startTime = performance.now();

  function scaleAt(t) {
    if (t < 0.3) return 0.4 + (0.8 * (t / 0.3));
    return 1.2 - (1.0 * ((t - 0.3) / 0.7));
  }

  function step(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const x = (1 - t) * (1 - t) * startX + 2 * (1 - t) * t * controlX + t * t * endX;
    const y = (1 - t) * (1 - t) * startY + 2 * (1 - t) * t * controlY + t * t * endY;
    const scale = scaleAt(t);
    const rotateDeg = t * 500;
    const opacity = t > 0.85 ? 1 - ((t - 0.85) / 0.15) * 0.6 : 1;

    cap.style.left = x + 'px';
    cap.style.top = y + 'px';
    cap.style.transform = `translate(-50%, -50%) scale(${scale}) rotate(${rotateDeg}deg)`;
    cap.style.opacity = opacity;

    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      cap.remove();
      if (sourceIconEl) sourceIconEl.style.opacity = '';
      target.style.transition = 'transform 0.2s ease';
      target.style.transform = 'scale(1.18)';
      setTimeout(() => { target.style.transform = 'scale(1)'; }, 200);
    }
  }
  requestAnimationFrame(step);
}

function flyGraduationCap(event) {
  const x = event && event.clientX ? event.clientX : null;
  const y = event && event.clientY ? event.clientY : null;
  flyGraduationCapFrom(x, y, null);
}

// ----------------------------------------------------------
// رسالة تأكيد صغيرة أسفل الشاشة بدل alert()
// ----------------------------------------------------------
function showBookingToast(message) {
  const toast = document.createElement('div');
  toast.textContent = message;
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '28px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#121216',
    border: '1px solid rgba(212,175,55,0.5)',
    color: '#fff',
    padding: '14px 22px',
    borderRadius: '14px',
    fontSize: '13px',
    maxWidth: '90vw',
    textAlign: 'center',
    zIndex: '9999',
    boxShadow: '0 10px 30px rgba(0,0,0,0.5)'
  });
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.4s'; }, 3200);
  setTimeout(() => toast.remove(), 3700);
}

// ----------------------------------------------------------
// دائرة الأفاتار بالهيدر (بدل نص "My Account")
// ----------------------------------------------------------
function renderAuthAvatar() {
  const desktopArea = document.getElementById('authArea');
  const mobileLink = document.getElementById('mobileAuthLink');
  if (!desktopArea) return;

  auth.onAuthStateChanged(async function (user) {
    if (!user) return;

    const fallbackInitial = (user.email || '?').charAt(0).toUpperCase();
    desktopArea.innerHTML =
      '<a href="account.html" class="w-10 h-10 rounded-full bg-gold text-black font-black text-xs flex items-center justify-center hover:opacity-90 transition shrink-0">' +
      fallbackInitial + '</a>';
    if (mobileLink) {
      mobileLink.href = 'account.html';
      mobileLink.innerHTML =
        '<span class="w-6 h-6 rounded-full bg-black/30 text-white flex items-center justify-center text-[10px] font-black">' + fallbackInitial + '</span>' +
        '<span data-ar="حسابي" data-en="My Account">' + (document.documentElement.getAttribute('lang') === 'ar' ? 'حسابي' : 'My Account') + '</span>';
    }

    try {
      const data = await getCurrentStudentData();
      if (data && data.name) {
        const initials = getInitials(data.name);
        const link = desktopArea.querySelector('a');
        if (link) link.textContent = initials;
        if (mobileLink) {
          const span = mobileLink.querySelector('span');
          if (span) span.textContent = initials;
        }
      }
    } catch (err) {
      console.error('renderAuthAvatar: could not load student data', err);
    }
  });
}
window.refreshAuthAvatar = renderAuthAvatar;

// ==========================================================
// سلة الاختيارات (Cart UI) - أيقونة بالهيدر + نافذة المراجعة والإرسال
// ==========================================================
function injectCartUI() {
  const authArea = document.getElementById('authArea');
  if (!authArea || document.getElementById('cartToggleBtn')) return;

  const cartBtn = document.createElement('button');
  cartBtn.id = 'cartToggleBtn';
  cartBtn.className = 'relative glass-card text-amber-400 border border-amber-500/30 w-10 h-10 rounded-xl flex items-center justify-center hover:bg-amber-500/10 transition shrink-0';
  cartBtn.innerHTML =
    '<i class="fa-solid fa-graduation-cap text-sm"></i>' +
    '<span id="cartBadge" class="hidden absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[10px] font-black rounded-full w-4 h-4 flex items-center justify-center">0</span>';
  cartBtn.onclick = openCartModal;
  authArea.parentElement.insertBefore(cartBtn, authArea);

  const modal = document.createElement('div');
  modal.id = 'cartModal';
  modal.className = 'hidden fixed inset-0 bg-black/80 z-[70] flex items-center justify-center px-6';
  modal.innerHTML = `
    <div class="glass-card bg-[#121216] border border-amber-500/40 rounded-3xl p-6 max-w-md w-full max-h-[85vh] overflow-y-auto">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-white font-black text-lg" data-ar="اختياراتي" data-en="My Selections">My Selections</h3>
        <button onclick="closeCartModal()" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
      </div>
      <p class="text-gray-400 text-xs mb-4" data-ar="راجع كل الدورات يلي اخترتها، وأضف أو احذف قد ما بدك قبل الإرسال النهائي." data-en="Review everything you've selected. Add or remove freely before your final submission.">Review everything you've selected. Add or remove freely before your final submission.</p>
      <div id="cartItemsList" class="space-y-2 mb-5"></div>
      <button onclick="submitCartClick()" id="submitCartBtn" class="hidden w-full bg-gold text-black font-black py-3 rounded-xl text-sm">
        <span data-ar="تأكيد وإرسال التسجيل" data-en="Confirm & Submit Registration">Confirm & Submit Registration</span>
      </button>
    </div>
  `;
  document.body.appendChild(modal);

  renderCartBadge();
}

function renderCartBadge() {
  const badge = document.getElementById('cartBadge');
  if (!badge) return;
  if (cart.length > 0) {
    badge.textContent = cart.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function renderCartItems() {
  const list = document.getElementById('cartItemsList');
  const submitBtn = document.getElementById('submitCartBtn');
  if (!list) return;

  if (cart.length === 0) {
    const emptyText = document.documentElement.getAttribute('lang') === 'ar' ? 'ما اخترت أي دورة بعد.' : "You haven't selected any courses yet.";
    list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6">' + emptyText + '</p>';
    if (submitBtn) submitBtn.classList.add('hidden');
    return;
  }
  if (submitBtn) submitBtn.classList.remove('hidden');

  list.innerHTML = cart.map((item, i) => `
    <div class="flex items-center justify-between bg-black/30 rounded-xl px-3 py-2.5 gap-2">
      <div>
        <p class="text-white font-bold text-sm">${item.courseName}</p>
        <p class="text-gray-400 text-xs mt-0.5">${item.redeemFreeCourse ? '🎁 Free Course' : (item.type === 'private' ? '👤 Private' : '👥 Group')} · $${item.basePrice}</p>
      </div>
      <button onclick="removeFromCart(${i})" class="text-red-400 hover:text-red-300 text-xl leading-none px-2 shrink-0">&times;</button>
    </div>
  `).join('');
}

function removeFromCart(index) {
  cart.splice(index, 1);
  localStorage.setItem('sketchy_cart', JSON.stringify(cart));
  renderCartBadge();
  renderCartItems();
}

function openCartModal() {
  renderCartItems();
  document.getElementById('cartModal').classList.remove('hidden');
  document.getElementById('cartModal').classList.add('flex');
}

function closeCartModal() {
  document.getElementById('cartModal').classList.add('hidden');
  document.getElementById('cartModal').classList.remove('flex');
}

async function submitCartClick() {
  if (cart.length === 0) return;
  const btn = document.getElementById('submitCartBtn');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    const result = await submitCart(cart);

    cart = [];
    localStorage.removeItem('sketchy_cart');
    renderCartBadge();
    closeCartModal();

    if (!result || result.added.length === 0) {
      showBookingToast('⚠️ You are already registered for all of these courses.');
    } else {
      let msg = `✅ Submitted ${result.added.length} course(s) for review. We'll confirm shortly!`;
      if (result.skipped && result.skipped.length > 0) {
        msg += ` (Already registered: ${result.skipped.join(', ')})`;
      }
      showBookingToast(msg);
    }

    if (window.refreshAuthAvatar) window.refreshAuthAvatar();
  } catch (err) {
    console.error(err);
    if (err && err.message === 'PROFILE_MISSING') {
      showBookingToast('⚠️ Your account profile is incomplete. Please sign up again with a new account.');
    } else {
      showBookingToast('⚠️ Something went wrong submitting your selections. Please try again.');
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

// ==========================================================
// جرس الإشعارات (Notifications) بالهيدر
// ==========================================================
function injectNotificationUI() {
  const authArea = document.getElementById('authArea');
  if (!authArea || document.getElementById('notifToggleBtn')) return;

  const bellBtn = document.createElement('button');
  bellBtn.id = 'notifToggleBtn';
  bellBtn.className = 'relative glass-card text-amber-400 border border-amber-500/30 w-10 h-10 rounded-xl flex items-center justify-center hover:bg-amber-500/10 transition shrink-0';
  bellBtn.innerHTML =
    '<i class="fa-solid fa-bell text-sm"></i>' +
    '<span id="notifBadge" class="hidden absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[10px] font-black rounded-full w-4 h-4 flex items-center justify-center">0</span>';
  bellBtn.onclick = openNotifModal;
  authArea.parentElement.insertBefore(bellBtn, authArea);

  const modal = document.createElement('div');
  modal.id = 'notifModal';
  modal.className = 'hidden fixed inset-0 bg-black/80 z-[70] flex items-center justify-center px-6';
  modal.innerHTML = `
    <div class="glass-card bg-[#121216] border border-amber-500/40 rounded-3xl p-6 max-w-md w-full max-h-[85vh] overflow-y-auto">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-white font-black text-lg" data-ar="الإشعارات" data-en="Notifications">Notifications</h3>
        <button onclick="closeNotifModal()" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
      </div>
      <div id="notifItemsList" class="space-y-2"></div>
    </div>
  `;
  document.body.appendChild(modal);

  auth.onAuthStateChanged(user => { if (user) refreshNotifBadge(); });
}

async function refreshNotifBadge() {
  if (!auth.currentUser) return;
  try {
    const data = await getCurrentStudentData();
    const unread = ((data && data.notifications) || []).filter(n => !n.read).length;
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    if (unread > 0) {
      badge.textContent = unread;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (err) {
    console.error('refreshNotifBadge failed:', err);
  }
}

async function openNotifModal() {
  const list = document.getElementById('notifItemsList');
  const data = await getCurrentStudentData();
  const notifications = ((data && data.notifications) || []).slice().reverse();

  if (notifications.length === 0) {
    list.innerHTML = '<p class="text-gray-500 text-sm text-center py-6" data-ar="لا توجد إشعارات بعد." data-en="No notifications yet.">No notifications yet.</p>';
  } else {
    list.innerHTML = notifications.map(n => `
      <div class="glass-card rounded-2xl p-3 ${n.read ? 'opacity-60' : ''}">
        <p class="text-white text-sm">${n.message}</p>
        <p class="text-gray-500 text-[10px] mt-1">${new Date(n.date).toLocaleString()}</p>
      </div>
    `).join('');
  }

  document.getElementById('notifModal').classList.remove('hidden');
  document.getElementById('notifModal').classList.add('flex');

  await markAllNotificationsRead();
  refreshNotifBadge();
}

function closeNotifModal() {
  document.getElementById('notifModal').classList.add('hidden');
  document.getElementById('notifModal').classList.remove('flex');
}

// شغّل كل شي أوتوماتيك أول ما الصفحة تحمّل (بعد ما firebase-init.js يخلص)
renderAuthAvatar();
injectCartUI();
injectNotificationUI();
