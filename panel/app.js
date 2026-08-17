// Panel personelu Nova Seafood — statyczny frontend (vanilla JS, ES module).
// Rozmawia wyłącznie z Supabase; Optima nigdy nie jest zapisywana.
// Nazwy tabel i kolumn 1:1 z docs/DATA_CONTRACT.md.
// supabase-js 2.49.4 jest przypięty lokalnie (vendor/supabase.js, UMD) —
// żadnego kodu z CDN; CSP w index.html dopuszcza skrypty tylko z 'self'.
const { createClient } = window.supabase;

// ── Konfiguracja ────────────────────────────────────────────────────────────
// Klucz publishable jest z założenia publiczny (ten sam co w aplikacji
// mobilnej) — dostępem rządzą RLS + allowlista staff_users. Bez wiersza
// w staff_users zalogowany użytkownik nie odczyta ani nie zapisze danych.
// Klucz publishable projektu firmowego (wdrożenie 15.08.2026). Jest jawny
// z założenia — dostępem rządzą RLS + allowlista staff_users. Kluczy
// `sb_secret_…` / legacy `service_role` NIGDY tu nie wklejamy.
const SUPABASE_URL = 'https://ztqhnqcxqlvcekekzkxg.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ZoersCWex9-bTo5dmi3UKA_G815i11n';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// ── Stan aplikacji ──────────────────────────────────────────────────────────
const state = {
  user: null,
  view: 'promocje',
  customersCache: null,      // lista klientów do filtrów (id, code, name)
  reservationCustomer: '',   // filtr klienta w widoku rezerwacji
};

let viewToken = 0; // unieważnia spóźnione odpowiedzi po zmianie widoku
let uidSeq = 0;    // unikalne nazwy grup radio w formularzach

// ── Drobne pomocniki DOM ────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape HTML — każdy tekst z bazy/użytkownika przechodzi tędy przed innerHTML. */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Wzorzec do `ilike` — usuwa znaki łamiące składnię filtra `.or()` PostgREST. */
const ilikePattern = (q) => `%${q.replace(/[,()%\\]/g, ' ').trim()}%`;

// ── Formatery PL ────────────────────────────────────────────────────────────
const fmtPln = (v) => v == null ? '—' : `${Number(v).toFixed(2).replace('.', ',')} zł`;
const fmtPct = (v) => v == null ? '—' : Number(v).toString().replace('.', ',');

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${fmtDate(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtAgo(iso) {
  if (!iso) return 'brak danych';
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'przed chwilą';
  if (min < 60) return `${min} min temu`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} godz. temu`;
  return `${Math.floor(h / 24)} dni temu`;
}

function fmtDuration(startIso, endIso) {
  if (!startIso || !endIso) return '—';
  const s = (new Date(endIso) - new Date(startIso)) / 1000;
  if (s < 0) return '—';
  if (s < 60) return `${s.toFixed(1).replace('.', ',')} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Słowniki (wartości z DATA_CONTRACT.md) ──────────────────────────────────
const SEGMENT_LABELS = {
  dystrybutor: 'Dystrybutor',
  przetworca: 'Przetwórca',
  gastronomia: 'Gastronomia',
};
const SEGMENTS = Object.keys(SEGMENT_LABELS);

// Kategorie aplikacji (slug = products.category z DATA_CONTRACT §1).
// Sterują widocznością cennika per klient (customer_categories, FEATURES_v2 §B).
const CATEGORY_LABELS = {
  marine: 'Ryby morskie',
  freshwater: 'Ryby słodkowodne',
  novatiger: 'NovaTiger',
  inne: 'Pozostałe',
};
const CATEGORIES = Object.keys(CATEGORY_LABELS);

const STATUS_LABELS = {
  bufor: 'Bufor',
  w_przygotowaniu: 'W przygotowaniu',
  potwierdzona: 'Potwierdzona',
  w_realizacji: 'W realizacji',
  zrealizowana: 'Zrealizowana',
  zamknieta: 'Zamknięta',
  anulowana: 'Anulowana',
};
const STATUS_CLASSES = {
  bufor: 'badge--muted',
  w_przygotowaniu: 'badge--muted',
  potwierdzona: 'badge--info',
  w_realizacji: 'badge--info',
  zrealizowana: 'badge--ok',
  zamknieta: 'badge--muted',
  anulowana: 'badge--danger',
};

// Statusy, które personel nadaje ręcznie (reservations.staff_status, FEATURES_v2 §C).
const STAFF_STATUSES = ['potwierdzona', 'w_realizacji', 'zrealizowana', 'zamknieta'];

/**
 * Status efektywny rezerwacji (co widzi klient) — liczony wg FEATURES_v2 §C:
 * anulowana w Optimie > status personelu > bufor (w_przygotowaniu) > potwierdzona.
 */
function effectiveResStatus(r) {
  if (r.optima_cancelled) return 'anulowana';
  if (r.staff_status) return r.staff_status;
  if (r.optima_bufor) return 'w_przygotowaniu';
  return 'potwierdzona';
}

function audienceLabel(row, customerCount) {
  if (row.audience === 'segment') return `Segment: ${SEGMENT_LABELS[row.segment] ?? row.segment ?? '?'}`;
  if (row.audience === 'customers') return `Wybrani klienci (${customerCount})`;
  return 'Wszyscy';
}

// ── Toasty i stany widoku ───────────────────────────────────────────────────
function toast(message, kind = 'error') {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

const toastError = (prefix, error) => toast(`${prefix}: ${error?.message ?? error}`);

const loadingHtml = () => '<p class="muted state">Ładowanie…</p>';
const errorHtml = () => '<p class="muted state">Nie udało się pobrać danych.</p>';
const emptyHtml = (msg) => `<p class="muted state">${esc(msg)}</p>`;

// ── Autoryzacja ─────────────────────────────────────────────────────────────
async function init() {
  $('#login-form').addEventListener('submit', onLogin);
  $('#logout-btn').addEventListener('click', onLogout);
  $$('.nav-item').forEach((btn) =>
    btn.addEventListener('click', () => switchView(btn.dataset.view)));

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && state.user) showLogin();
  });

  const { data: { session } } = await supabase.auth.getSession();
  if (session) await enterApp(session.user);
  else showLogin();
}

async function onLogin(e) {
  e.preventDefault();
  const btn = $('#login-submit');
  btn.disabled = true;
  const { data, error } = await supabase.auth.signInWithPassword({
    email: $('#login-email').value.trim(),
    password: $('#login-password').value,
  });
  btn.disabled = false;
  if (error) return toast(`Logowanie nieudane: ${error.message}`);
  await enterApp(data.user);
}

/** Bramka personelu: bez własnego wiersza w staff_users wylogowujemy. */
async function enterApp(user) {
  const { data: staff, error } = await supabase
    .from('staff_users')
    .select('user_id, display_name')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error || !staff) {
    await supabase.auth.signOut();
    showLogin();
    return toast('Brak uprawnień — konto nie znajduje się na liście personelu.');
  }
  state.user = user;
  $('#user-label').textContent = staff.display_name || user.email || '';
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');

  // Klik w powiadomienie push otwiera panel z ?view=zapytania — wchodzimy
  // od razu na właściwą zakładkę zamiast na domyślne Promocje.
  const wanted = new URLSearchParams(location.search).get('view');
  if (wanted && Object.prototype.hasOwnProperty.call(VIEWS, wanted)) {
    state.view = wanted;
  }

  switchView(state.view);
  refreshInquiriesBadge();
  initPush();
}

function showLogin() {
  state.user = null;
  state.customersCache = null;
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
}

async function onLogout() {
  await supabase.auth.signOut();
  showLogin();
}

// ── Powiadomienia push (Web Push / VAPID) ───────────────────────────────────
// Personel dostaje powiadomienie na telefon/komputer, gdy klient kliknie
// „Zapytaj o produkt" — także przy ZAMKNIĘTYM panelu. Odbiera je sw.js,
// wysyła Edge Function `notify-push`. Klucz publiczny VAPID jest z założenia
// jawny (identyfikuje nadawcę; wysyłać może tylko posiadacz klucza prywatnego,
// który żyje wyłącznie w sekretach Supabase).
const VAPID_PUBLIC_KEY =
  'BCaszJCksrAw3rajPbNc4kGf_QEZIp5mSUKPYYT_h6fD1VfrIU2_FL70-UBNpkVweR9Jv2WlDLTo5gTF3G6MbY4';

/** Klucz VAPID (base64url) → Uint8Array, jakiego wymaga pushManager.subscribe. */
function vapidKeyToBytes(base64url) {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Czytelna etykieta urządzenia dla samego personelu („Android - Chrome"). */
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad|iOS/i.test(ua) ? 'iOS'
    : /Windows/i.test(ua) ? 'Windows'
    : /Macintosh|Mac OS/i.test(ua) ? 'macOS'
    : /Linux/i.test(ua) ? 'Linux' : null;
  const browser = /Edg\//i.test(ua) ? 'Edge'
    : /OPR\/|Opera/i.test(ua) ? 'Opera'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /Safari\//i.test(ua) ? 'Safari' : null;
  return [os, browser].filter(Boolean).join(' - ') || null;
}

const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** Aktualizuje napis na przycisku wg stanu subskrypcji. */
function setPushButton(state_) {
  const btn = $('#push-btn');
  if (!btn) return;
  const LABELS = {
    on: 'Powiadomienia: włączone',
    off: 'Włącz powiadomienia',
    blocked: 'Powiadomienia zablokowane',
    working: 'Chwileczkę…',
  };
  btn.textContent = LABELS[state_] ?? LABELS.off;
  btn.disabled = state_ === 'working' || state_ === 'blocked';
  btn.dataset.pushState = state_;
}

/** Rejestruje service workera i ustawia stan przycisku po zalogowaniu. */
async function initPush() {
  const btn = $('#push-btn');
  if (!btn) return;
  if (!pushSupported()) {
    btn.classList.add('hidden'); // np. iOS Safari bez „Dodaj do ekranu głównego"
    return;
  }
  btn.classList.remove('hidden');
  btn.onclick = onPushToggle;

  try {
    await navigator.serviceWorker.register('sw.js');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (Notification.permission === 'denied') return setPushButton('blocked');
    setPushButton(sub ? 'on' : 'off');
  } catch (err) {
    console.error('Rejestracja service workera nieudana', err);
    btn.classList.add('hidden');
  }
}

/** Włącza albo wyłącza powiadomienia (jeden przycisk, dwa kierunki). */
async function onPushToggle() {
  const btn = $('#push-btn');
  const wasOn = btn.dataset.pushState === 'on';
  setPushButton('working');
  try {
    if (wasOn) await disablePush();
    else await enablePush();
  } catch (err) {
    toastError('Nie udało się zmienić ustawień powiadomień', err);
    setPushButton(wasOn ? 'on' : 'off');
  }
}

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    setPushButton(permission === 'denied' ? 'blocked' : 'off');
    toast(permission === 'denied'
      ? 'Powiadomienia zablokowane w przeglądarce — odblokuj je w ustawieniach strony.'
      : 'Powiadomienia nie zostały włączone.');
    return;
  }

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true, // wymóg przeglądarek: każdy push musi coś pokazać
    applicationServerKey: vapidKeyToBytes(VAPID_PUBLIC_KEY),
  });

  // Zapis subskrypcji; endpoint jest UNIQUE, więc ponowne włączenie na tym
  // samym urządzeniu odświeża wiersz zamiast tworzyć duplikat.
  const raw = sub.toJSON();
  const { error } = await supabase
    .from('staff_push_subscriptions')
    .upsert({
      user_id: state.user.id,
      endpoint: raw.endpoint,
      p256dh: raw.keys.p256dh,
      auth: raw.keys.auth,
      label: deviceLabel(),
      is_active: true,
    }, { onConflict: 'endpoint' });
  if (error) {
    await sub.unsubscribe().catch(() => {}); // nie zostawiaj sieroty w przeglądarce
    throw error;
  }

  setPushButton('on');
  toast('Powiadomienia włączone — wysyłam próbne…', 'ok');

  // Próbne powiadomienie: od razu widać, czy dochodzi na to urządzenie
  // (bez czekania na pierwsze prawdziwe zapytanie klienta). Funkcja wysyła
  // je WYŁĄCZNIE na urządzenia tego samego użytkownika.
  const { error: testError } = await supabase.functions.invoke('notify-push', {
    body: { test: true },
  });
  if (testError) {
    toast('Zapisano subskrypcję, ale próbne powiadomienie nie doszło — sprawdź ustawienia przeglądarki.');
  }
}

async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    const { error } = await supabase
      .from('staff_push_subscriptions')
      .delete()
      .eq('endpoint', sub.endpoint);
    if (error) throw error;
    await sub.unsubscribe().catch(() => {});
  }
  setPushButton('off');
  toast('Powiadomienia wyłączone na tym urządzeniu.', 'ok');
}

// ── Nawigacja ───────────────────────────────────────────────────────────────
const VIEWS = {
  promocje: renderPromotions,
  powiadomienia: renderNotifications,
  zapytania: renderInquiries,
  rezerwacje: renderReservations,
  klienci: renderCustomers,
  katalog: renderCatalog,
  sync: renderSync,
};

function switchView(view) {
  state.view = view;
  $$('.nav-item').forEach((b) =>
    b.classList.toggle('nav-item--active', b.dataset.view === view));
  VIEWS[view]();
}

/**
 * Licznik nieobsłużonych zapytań (status='new') na pozycji „Zapytania" w menu.
 * Odświeżany po wejściu do panelu i po każdej zmianie stanu zapytania.
 */
async function refreshInquiriesBadge() {
  const badge = $('#nav-inquiries-badge');
  if (!badge) return;
  const { count, error } = await supabase
    .from('product_inquiries')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'new');
  if (error || !count) {
    badge.textContent = '';
    badge.classList.add('hidden');
    return;
  }
  badge.textContent = String(count);
  badge.classList.remove('hidden');
}

// ── Cache klientów (filtry i pickery) ───────────────────────────────────────
async function loadCustomersCache() {
  if (state.customersCache) return state.customersCache;
  const { data, error } = await supabase
    .from('customers')
    .select('id, code, name')
    .order('name')
    .limit(2000);
  if (error) {
    toastError('Nie udało się pobrać listy klientów', error);
    return [];
  }
  state.customersCache = data;
  return data;
}

// ── Modal ───────────────────────────────────────────────────────────────────
function openModal(title, bodyHtml) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal" role="dialog" aria-modal="true">
        <header class="modal-head">
          <h2>${esc(title)}</h2>
          <button type="button" class="modal-close" aria-label="Zamknij">×</button>
        </header>
        <div class="modal-body">${bodyHtml}</div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  $('.modal-close', root).addEventListener('click', close);
  $('.modal-overlay', root).addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  return { root, close };
}

// ── Picker produktu (żywe wyszukiwanie po nazwie/kodzie) ────────────────────
function productPricesLabel(product) {
  const prices = (product.product_prices ?? [])
    .slice()
    .sort((a, b) => a.price_level - b.price_level)
    .map((p) => `poz. ${p.price_level}: ${fmtPln(p.net_price)}`)
    .join(' · ');
  return prices || 'brak cen bazowych';
}

function mountProductPicker(container, initial = null) {
  let selected = initial;
  container.innerHTML = `
    <div class="picked hidden"></div>
    <div class="search-box">
      <input type="text" placeholder="Szukaj produktu (nazwa lub kod)…" autocomplete="off">
      <div class="search-results hidden"></div>
    </div>`;
  const pickedEl = $('.picked', container);
  const searchBox = $('.search-box', container);
  const input = $('input', container);
  const resultsEl = $('.search-results', container);

  function renderPicked() {
    if (!selected) {
      pickedEl.classList.add('hidden');
      searchBox.classList.remove('hidden');
      return;
    }
    pickedEl.innerHTML = `
      <div class="picked-main">
        <strong>${esc(selected.name)}</strong> <span class="muted">(${esc(selected.code)})</span>
        ${selected.spec ? `<div class="muted small">${esc(selected.spec)}</div>` : ''}
        <div class="small">${esc(productPricesLabel(selected))}</div>
      </div>
      <button type="button" class="btn btn-ghost" data-clear>Zmień</button>`;
    pickedEl.classList.remove('hidden');
    searchBox.classList.add('hidden');
    $('[data-clear]', pickedEl).addEventListener('click', () => {
      selected = null;
      renderPicked();
      input.value = '';
      input.focus();
    });
  }

  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) return resultsEl.classList.add('hidden');
    const pat = ilikePattern(q);
    const { data, error } = await supabase
      .from('products')
      .select('id, code, name, spec, product_prices(price_level, net_price)')
      .or(`name.ilike.${pat},code.ilike.${pat}`)
      .eq('is_active', true)
      .order('name')
      .limit(12);
    if (error) return toastError('Błąd wyszukiwania produktów', error);
    resultsEl.innerHTML = data.length === 0
      ? '<div class="search-empty">Brak wyników.</div>'
      : data.map((p, i) => `
          <button type="button" class="search-item" data-i="${i}">
            <span><strong>${esc(p.name)}</strong> <span class="muted">(${esc(p.code)})</span></span>
            ${p.spec ? `<span class="muted small">${esc(p.spec)}</span>` : ''}
            <span class="small">${esc(productPricesLabel(p))}</span>
          </button>`).join('');
    resultsEl.classList.remove('hidden');
    $$('.search-item', resultsEl).forEach((btn) =>
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault(); // nie zabieraj focusu przed obsłużeniem wyboru
        selected = data[Number(btn.dataset.i)];
        resultsEl.classList.add('hidden');
        renderPicked();
      }));
  });

  input.addEventListener('input', search);
  input.addEventListener('blur', () => resultsEl.classList.add('hidden'));
  renderPicked();
  return { get: () => selected };
}

// ── Multi-picker klientów (chipy + wyszukiwarka) ────────────────────────────
function mountCustomerMultiPicker(container, initial = []) {
  const selected = new Map(initial.map((c) => [c.id, c]));
  container.innerHTML = `
    <div class="chips"></div>
    <div class="search-box">
      <input type="text" placeholder="Szukaj klienta (nazwa lub kod)…" autocomplete="off">
      <div class="search-results hidden"></div>
    </div>`;
  const chipsEl = $('.chips', container);
  const input = $('input', container);
  const resultsEl = $('.search-results', container);

  function renderChips() {
    chipsEl.innerHTML = [...selected.values()].map((c) => `
      <span class="chip">${esc(c.name)}
        <button type="button" data-rm="${esc(c.id)}" aria-label="Usuń">×</button>
      </span>`).join('');
    $$('[data-rm]', chipsEl).forEach((b) =>
      b.addEventListener('click', () => {
        selected.delete(b.dataset.rm);
        renderChips();
      }));
  }

  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) return resultsEl.classList.add('hidden');
    const pat = ilikePattern(q);
    const { data, error } = await supabase
      .from('customers')
      .select('id, code, name')
      .or(`name.ilike.${pat},code.ilike.${pat}`)
      .order('name')
      .limit(10);
    if (error) return toastError('Błąd wyszukiwania klientów', error);
    resultsEl.innerHTML = data.length === 0
      ? '<div class="search-empty">Brak wyników.</div>'
      : data.map((c, i) => `
          <button type="button" class="search-item" data-i="${i}">
            <span><strong>${esc(c.name)}</strong> ${c.code ? `<span class="muted">(${esc(c.code)})</span>` : ''}</span>
          </button>`).join('');
    resultsEl.classList.remove('hidden');
    $$('.search-item', resultsEl).forEach((btn) =>
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const c = data[Number(btn.dataset.i)];
        selected.set(c.id, c);
        renderChips();
        input.value = '';
        resultsEl.classList.add('hidden');
      }));
  });

  input.addEventListener('input', search);
  input.addEventListener('blur', () => resultsEl.classList.add('hidden'));
  renderChips();
  return { get: () => [...selected.keys()] };
}

// ── Picker odbiorców: all / segment / customers (promocje + powiadomienia) ──
function mountAudiencePicker(container, initial = {}) {
  const name = `aud-${++uidSeq}`;
  const audience = initial.audience ?? 'all';
  const OPTION_LABELS = { all: 'Wszyscy klienci', segment: 'Segment', customers: 'Wybrani klienci' };
  container.innerHTML = `
    <div class="radio-row">
      ${Object.entries(OPTION_LABELS).map(([v, label]) => `
        <label class="radio">
          <input type="radio" name="${name}" value="${v}" ${v === audience ? 'checked' : ''}> ${label}
        </label>`).join('')}
    </div>
    <div class="aud-segment ${audience === 'segment' ? '' : 'hidden'}">
      <select>
        ${SEGMENTS.map((s) => `<option value="${s}" ${initial.segment === s ? 'selected' : ''}>${SEGMENT_LABELS[s]}</option>`).join('')}
      </select>
    </div>
    <div class="aud-customers ${audience === 'customers' ? '' : 'hidden'}"></div>`;

  const segmentBox = $('.aud-segment', container);
  const customersBox = $('.aud-customers', container);
  const picker = mountCustomerMultiPicker(customersBox, initial.customers ?? []);

  $$(`input[name="${name}"]`, container).forEach((r) =>
    r.addEventListener('change', () => {
      segmentBox.classList.toggle('hidden', r.value !== 'segment');
      customersBox.classList.toggle('hidden', r.value !== 'customers');
    }));

  return {
    get() {
      const checked = $(`input[name="${name}"]:checked`, container).value;
      return {
        audience: checked,
        segment: checked === 'segment' ? $('select', segmentBox).value : null,
        customerIds: checked === 'customers' ? picker.get() : [],
      };
    },
  };
}

// ── Widok: Promocje ─────────────────────────────────────────────────────────
function promoStatus(p) {
  const today = todayIso();
  if (!p.is_active) return { label: 'Wyłączona', cls: 'badge--muted' };
  if (p.valid_until && p.valid_until < today) return { label: 'Zakończona', cls: 'badge--muted' };
  if (p.valid_from && p.valid_from > today) return { label: 'Zaplanowana', cls: 'badge--info' };
  return { label: 'Aktywna', cls: 'badge--ok' };
}

function promoValueLabel(p) {
  if (p.promo_net_price != null) return `${fmtPln(p.promo_net_price)} netto`;
  if (p.discount_pct != null) return `rabat ${fmtPct(p.discount_pct)}%`;
  return '—';
}

async function renderPromotions() {
  const view = $('#view');
  const token = ++viewToken;
  view.innerHTML = loadingHtml();

  const { data, error } = await supabase
    .from('promotions')
    .select('*, products(code, name), promotion_customers(count)')
    .order('is_active', { ascending: false })
    .order('valid_until', { ascending: false });
  if (token !== viewToken) return;
  if (error) {
    view.innerHTML = errorHtml();
    return toastError('Błąd pobierania promocji', error);
  }

  const rows = data.map((p) => {
    const st = promoStatus(p);
    const cnt = p.promotion_customers?.[0]?.count ?? 0;
    return `
      <tr>
        <td><strong>${esc(p.title)}</strong>${p.tag ? `<span class="tag">${esc(p.tag)}</span>` : ''}</td>
        <td>${p.products ? `${esc(p.products.name)} <span class="muted">(${esc(p.products.code)})</span>` : '—'}</td>
        <td class="nowrap">${esc(promoValueLabel(p))}</td>
        <td class="nowrap">${fmtDate(p.valid_from)} – ${fmtDate(p.valid_until)}</td>
        <td>${esc(audienceLabel(p, cnt))}</td>
        <td><span class="badge ${st.cls}">${st.label}</span></td>
        <td class="row-actions">
          <button type="button" class="btn btn-ghost" data-promo-edit="${esc(p.id)}">Edytuj</button>
          ${p.is_active ? `<button type="button" class="btn btn-ghost btn-danger" data-promo-off="${esc(p.id)}">Dezaktywuj</button>` : ''}
        </td>
      </tr>`;
  }).join('');

  view.innerHTML = `
    <header class="view-head">
      <h1>Promocje</h1>
      <button type="button" class="btn btn-primary" id="promo-add">+ Nowa promocja</button>
    </header>
    ${data.length === 0 ? emptyHtml('Brak promocji — dodaj pierwszą.') : `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Tytuł</th><th>Produkt</th><th>Promocja</th><th>Ważność</th>
            <th>Odbiorcy</th><th>Status</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`}`;

  $('#promo-add').addEventListener('click', () => openPromoModal(null));
  $$('[data-promo-edit]').forEach((b) =>
    b.addEventListener('click', () => openPromoModal(data.find((p) => p.id === b.dataset.promoEdit))));
  $$('[data-promo-off]').forEach((b) =>
    b.addEventListener('click', () => deactivatePromo(b.dataset.promoOff)));
}

async function deactivatePromo(id) {
  if (!confirm('Dezaktywować promocję? Klienci przestaną ją widzieć w aplikacji.')) return;
  const { error } = await supabase.from('promotions').update({ is_active: false }).eq('id', id);
  if (error) return toastError('Nie udało się dezaktywować promocji', error);
  toast('Promocja dezaktywowana.', 'ok');
  renderPromotions();
}

async function openPromoModal(promo) {
  const isEdit = Boolean(promo);

  // Przy edycji dociągamy pełny produkt (spec + ceny) i wybranych klientów.
  let initialProduct = null;
  let initialCustomers = [];
  if (promo?.product_id) {
    const { data } = await supabase
      .from('products')
      .select('id, code, name, spec, product_prices(price_level, net_price)')
      .eq('id', promo.product_id)
      .maybeSingle();
    initialProduct = data ?? null;
  }
  if (promo?.audience === 'customers') {
    const { data, error } = await supabase
      .from('promotion_customers')
      .select('customer_id, customers(id, code, name)')
      .eq('promotion_id', promo.id);
    if (error) toastError('Nie udało się pobrać adresatów promocji', error);
    initialCustomers = (data ?? []).map((r) => r.customers).filter(Boolean);
  }

  const typeName = `ptype-${++uidSeq}`;
  const isDiscount = promo?.discount_pct != null;
  const { root, close } = openModal(isEdit ? 'Edytuj promocję' : 'Nowa promocja', `
    <form id="promo-form" class="form">
      <label class="field">Tytuł*
        <input type="text" id="pf-title" required maxlength="120" value="${esc(promo?.title ?? '')}">
      </label>
      <label class="field">Tag
        <input type="text" id="pf-tag" maxlength="40" placeholder="np. HIT TYGODNIA" value="${esc(promo?.tag ?? '')}">
      </label>
      <label class="field">Opis
        <textarea id="pf-desc" rows="2">${esc(promo?.description ?? '')}</textarea>
      </label>
      <div class="field">
        <span class="field-label">Produkt (puste = promocja ogólna)</span>
        <div id="pf-product"></div>
      </div>
      <div class="field">
        <span class="field-label">Rodzaj promocji* (dokładnie jedno z dwóch)</span>
        <div class="radio-row">
          <label class="radio"><input type="radio" name="${typeName}" value="price" ${isDiscount ? '' : 'checked'}> Cena promocyjna (netto)</label>
          <label class="radio"><input type="radio" name="${typeName}" value="discount" ${isDiscount ? 'checked' : ''}> Rabat %</label>
        </div>
        <div class="field-row">
          <label class="field">Cena netto [zł]
            <input type="number" id="pf-price" step="0.01" min="0.01" value="${esc(promo?.promo_net_price ?? '')}">
          </label>
          <label class="field">Rabat [%]
            <input type="number" id="pf-pct" step="0.01" min="0.01" max="100" value="${esc(promo?.discount_pct ?? '')}">
          </label>
        </div>
      </div>
      <div class="field-row">
        <label class="field">Ważna od*
          <input type="date" id="pf-from" required value="${esc(promo?.valid_from ?? todayIso())}">
        </label>
        <label class="field">Ważna do*
          <input type="date" id="pf-until" required value="${esc(promo?.valid_until ?? '')}">
        </label>
      </div>
      <div class="field">
        <span class="field-label">Odbiorcy*</span>
        <div id="pf-audience"></div>
      </div>
      <label class="check">
        <input type="checkbox" id="pf-active" ${(promo?.is_active ?? true) ? 'checked' : ''}> Promocja aktywna
      </label>
      <footer class="modal-actions">
        <button type="button" class="btn btn-ghost" id="pf-cancel">Anuluj</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Zapisz zmiany' : 'Utwórz promocję'}</button>
      </footer>
    </form>`);

  const productPicker = mountProductPicker($('#pf-product', root), initialProduct);
  const audiencePicker = mountAudiencePicker($('#pf-audience', root), {
    audience: promo?.audience,
    segment: promo?.segment,
    customers: initialCustomers,
  });

  // XOR ceny i rabatu — jak CHECK w tabeli promotions.
  function syncPromoType() {
    const t = $(`input[name="${typeName}"]:checked`, root).value;
    $('#pf-price', root).disabled = t !== 'price';
    $('#pf-pct', root).disabled = t !== 'discount';
  }
  $$(`input[name="${typeName}"]`, root).forEach((r) => r.addEventListener('change', syncPromoType));
  syncPromoType();

  $('#pf-cancel', root).addEventListener('click', close);
  $('#promo-form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = $(`input[name="${typeName}"]:checked`, root).value;
    const price = parseFloat($('#pf-price', root).value);
    const pct = parseFloat($('#pf-pct', root).value);
    if (t === 'price' && !(price > 0)) return toast('Podaj cenę promocyjną większą od zera.');
    if (t === 'discount' && !(pct > 0 && pct <= 100)) return toast('Podaj rabat w zakresie 0–100%.');

    const from = $('#pf-from', root).value;
    const until = $('#pf-until', root).value;
    if (!until) return toast('Podaj datę końca promocji.');
    if (from && until < from) return toast('Data „do” nie może być wcześniejsza niż „od”.');

    const aud = audiencePicker.get();
    if (aud.audience === 'customers' && aud.customerIds.length === 0) {
      return toast('Wybierz co najmniej jednego klienta.');
    }

    const payload = {
      title: $('#pf-title', root).value.trim(),
      tag: $('#pf-tag', root).value.trim() || null,
      description: $('#pf-desc', root).value.trim() || null,
      product_id: productPicker.get()?.id ?? null,
      promo_net_price: t === 'price' ? price : null,
      discount_pct: t === 'discount' ? pct : null,
      valid_from: from || todayIso(),
      valid_until: until,
      audience: aud.audience,
      segment: aud.segment,
      is_active: $('#pf-active', root).checked,
    };
    if (!payload.title) return toast('Podaj tytuł promocji.');

    let promoId = promo?.id;
    if (isEdit) {
      const { error } = await supabase.from('promotions').update(payload).eq('id', promoId);
      if (error) return toastError('Nie udało się zapisać promocji', error);
    } else {
      payload.created_by = state.user.id;
      const { data, error } = await supabase.from('promotions').insert(payload).select('id').single();
      if (error) return toastError('Nie udało się utworzyć promocji', error);
      promoId = data.id;
    }

    // Listę adresatów nadpisujemy w całości — proste i przewidywalne.
    const { error: delErr } = await supabase
      .from('promotion_customers').delete().eq('promotion_id', promoId);
    if (delErr) return toastError('Błąd zapisu adresatów promocji', delErr);
    if (aud.audience === 'customers') {
      const rows = aud.customerIds.map((cid) => ({ promotion_id: promoId, customer_id: cid }));
      const { error: insErr } = await supabase.from('promotion_customers').insert(rows);
      if (insErr) return toastError('Błąd zapisu adresatów promocji', insErr);
    }

    toast(isEdit ? 'Zapisano promocję.' : 'Utworzono promocję.', 'ok');
    close();
    renderPromotions();
  });
}

// ── Widok: Powiadomienia ────────────────────────────────────────────────────
async function renderNotifications() {
  const view = $('#view');
  const token = ++viewToken;
  view.innerHTML = loadingHtml();

  const { data, error } = await supabase
    .from('notifications')
    .select('*, notification_customers(count), products(code, name)')
    .order('sent_at', { ascending: false })
    .limit(50);
  if (token !== viewToken) return;
  if (error) {
    view.innerHTML = errorHtml();
    return toastError('Błąd pobierania powiadomień', error);
  }

  view.innerHTML = `
    <header class="view-head"><h1>Powiadomienia</h1></header>
    <section class="card">
      <h2>Nowe powiadomienie</h2>
      <form id="notif-form" class="form">
        <label class="field">Tytuł*
          <input type="text" id="nf-title" required maxlength="120">
        </label>
        <label class="field">Treść*
          <textarea id="nf-body" rows="3" required></textarea>
        </label>
        <div class="field">
          <span class="field-label">Produkt (opcjonalnie — powiadomienie linkuje do niego w Cenniku)</span>
          <div id="nf-product"></div>
        </div>
        <div class="field">
          <span class="field-label">Odbiorcy*</span>
          <div id="nf-audience"></div>
        </div>
        <footer class="modal-actions">
          <button type="submit" class="btn btn-primary">Wyślij powiadomienie</button>
        </footer>
      </form>
    </section>
    <h2 class="section-title">Historia (ostatnie 50)</h2>
    ${data.length === 0 ? emptyHtml('Brak wysłanych powiadomień.') : `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Wysłano</th><th>Tytuł</th><th>Treść</th><th>Produkt</th><th>Odbiorcy</th></tr></thead>
          <tbody>${data.map((n) => `
            <tr>
              <td class="nowrap">${esc(fmtDateTime(n.sent_at))}</td>
              <td><strong>${esc(n.title)}</strong></td>
              <td class="cell-wide">${esc(n.body)}</td>
              <td class="nowrap">${n.products ? `${esc(n.products.name)} <span class="muted">(${esc(n.products.code)})</span>` : '—'}</td>
              <td class="nowrap">${esc(audienceLabel(n, n.notification_customers?.[0]?.count ?? 0))}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`}`;

  const productPicker = mountProductPicker($('#nf-product'), null);
  const audiencePicker = mountAudiencePicker($('#nf-audience'), {});
  $('#notif-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('#nf-title').value.trim();
    const body = $('#nf-body').value.trim();
    if (!title || !body) return toast('Podaj tytuł i treść powiadomienia.');
    const aud = audiencePicker.get();
    if (aud.audience === 'customers' && aud.customerIds.length === 0) {
      return toast('Wybierz co najmniej jednego klienta.');
    }

    const { data: inserted, error: insErr } = await supabase
      .from('notifications')
      .insert({
        title,
        body,
        product_id: productPicker.get()?.id ?? null,
        audience: aud.audience,
        segment: aud.segment,
        created_by: state.user.id,
      })
      .select('id')
      .single();
    if (insErr) return toastError('Nie udało się wysłać powiadomienia', insErr);

    if (aud.audience === 'customers') {
      const rows = aud.customerIds.map((cid) => ({ notification_id: inserted.id, customer_id: cid }));
      const { error: linkErr } = await supabase.from('notification_customers').insert(rows);
      if (linkErr) return toastError('Powiadomienie zapisane, ale lista adresatów nie', linkErr);
    }

    toast('Powiadomienie wysłane.', 'ok');
    renderNotifications();
  });
}

// ── Widok: Zapytania o produkty (FEATURES_v2 §D) ────────────────────────────
// Klient klika „Zapytaj o produkt" w aplikacji → wiersz w product_inquiries.
// Personel widzi listę (najnowsze u góry) i oznacza jako obsłużone.
async function renderInquiries() {
  const view = $('#view');
  const token = ++viewToken;
  view.innerHTML = loadingHtml();

  const { data, error } = await supabase
    .from('product_inquiries')
    .select('*, customers(code, name), products(code, name)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (token !== viewToken) return;
  if (error) {
    view.innerHTML = errorHtml();
    return toastError('Błąd pobierania zapytań', error);
  }
  refreshInquiriesBadge();

  // Produkt: gdy istnieje join (products) pokazujemy nazwę+kod, inaczej
  // zapamiętaną product_name (produkt mógł zniknąć — ON DELETE SET NULL).
  const productLabel = (q) => q.products
    ? `${esc(q.products.name)} <span class="muted">(${esc(q.products.code)})</span>`
    : (q.product_name ? esc(q.product_name) : '<span class="muted">—</span>');

  const rows = data.map((q) => {
    const isNew = q.status === 'new';
    return `
      <tr>
        <td class="nowrap">${esc(fmtDateTime(q.created_at))}</td>
        <td>${q.customers ? `${esc(q.customers.name)} <span class="muted">(${esc(q.customers.code)})</span>` : '—'}</td>
        <td>${productLabel(q)}</td>
        <td class="cell-wide">${q.message ? esc(q.message) : '<span class="muted">—</span>'}</td>
        <td><span class="badge ${isNew ? 'badge--info' : 'badge--muted'}">${isNew ? 'Nowe' : 'Obsłużone'}</span></td>
        <td class="row-actions">${isNew
          ? `<button type="button" class="btn btn-ghost" data-inq-handle="${esc(q.id)}">Oznacz jako obsłużone</button>`
          : '<span class="muted">—</span>'}</td>
      </tr>`;
  }).join('');

  view.innerHTML = `
    <header class="view-head"><h1>Zapytania o produkty</h1></header>
    <p class="muted small">Zapytania klientów z aplikacji („Zapytaj o produkt"). Najnowsze u góry.</p>
    ${data.length === 0 ? emptyHtml('Brak zapytań.') : `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Data</th><th>Klient</th><th>Produkt</th><th>Wiadomość</th><th>Status</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`}`;

  $$('[data-inq-handle]').forEach((b) =>
    b.addEventListener('click', () => handleInquiry(b.dataset.inqHandle)));
}

async function handleInquiry(id) {
  const { error } = await supabase
    .from('product_inquiries')
    .update({ status: 'handled', handled_by: state.user.id })
    .eq('id', id);
  if (error) return toastError('Nie udało się oznaczyć zapytania', error);
  toast('Zapytanie oznaczone jako obsłużone.', 'ok');
  renderInquiries();
}

// ── Widok: Rezerwacje (odczyt + edycja planned_delivery i staff_status) ─────
async function renderReservations() {
  const view = $('#view');
  const token = ++viewToken;
  view.innerHTML = loadingHtml();

  const customers = await loadCustomersCache();
  let query = supabase
    .from('reservations')
    .select('*, customers(code, name)')
    .order('document_date', { ascending: false, nullsFirst: false })
    .order('optima_id', { ascending: false })
    .limit(200);
  if (state.reservationCustomer) query = query.eq('customer_id', state.reservationCustomer);
  const { data, error } = await query;
  if (token !== viewToken) return;
  if (error) {
    view.innerHTML = errorHtml();
    return toastError('Błąd pobierania rezerwacji', error);
  }

  // Kontekst z Optimy (tylko odczyt): w buforze / anulowana / poza buforem.
  const optimaCell = (r) => {
    if (r.optima_cancelled) return '<span class="badge badge--danger">Anulowana</span>';
    if (r.optima_bufor) return '<span class="badge badge--muted">Bufor</span>';
    return '<span class="muted small">poza buforem</span>';
  };

  view.innerHTML = `
    <header class="view-head">
      <h1>Rezerwacje</h1>
      <label class="filter">Klient
        <select id="res-filter">
          <option value="">— wszyscy —</option>
          ${customers.map((c) => `
            <option value="${esc(c.id)}" ${c.id === state.reservationCustomer ? 'selected' : ''}>
              ${esc(c.name)}${c.code ? ` (${esc(c.code)})` : ''}
            </option>`).join('')}
        </select>
      </label>
    </header>
    <p class="muted small">Baza rezerwacji pochodzi z Optimy (tylko odczyt: bufor / anulowana). Status dla klienta i planowaną dostawę ustawia personel — „auto" oznacza status wyliczony (bufor → W przygotowaniu, inaczej Potwierdzona).</p>
    ${data.length === 0 ? emptyHtml('Brak rezerwacji.') : `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Dokument</th><th>Klient</th><th>Status efektywny</th><th>Optima</th>
            <th>Status personelu</th><th>Data dok.</th><th>Rezerwacja do</th>
            <th>Netto</th><th>Planowana dostawa</th>
          </tr></thead>
          <tbody>${data.map((r) => {
            const eff = effectiveResStatus(r);
            return `
            <tr>
              <td class="nowrap"><strong>${esc(r.document_number)}</strong></td>
              <td>${r.customers ? `${esc(r.customers.name)} <span class="muted">(${esc(r.customers.code)})</span>` : '—'}</td>
              <td><span class="badge ${STATUS_CLASSES[eff] ?? 'badge--muted'}">${esc(STATUS_LABELS[eff] ?? eff)}</span></td>
              <td class="nowrap">${optimaCell(r)}</td>
              <td>
                <select data-res-status="${esc(r.id)}">
                  <option value="" ${!r.staff_status ? 'selected' : ''}>— auto —</option>
                  ${STAFF_STATUSES.map((s) => `<option value="${s}" ${r.staff_status === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
                </select>
              </td>
              <td class="nowrap">${fmtDate(r.document_date)}</td>
              <td class="nowrap">${fmtDate(r.reserved_until)}</td>
              <td class="nowrap">${fmtPln(r.net_total)}</td>
              <td><input type="date" data-res-id="${esc(r.id)}" value="${esc(r.planned_delivery ?? '')}"></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`}`;

  $('#res-filter').addEventListener('change', (e) => {
    state.reservationCustomer = e.target.value;
    renderReservations();
  });
  $$('input[data-res-id]').forEach((inp) =>
    inp.addEventListener('change', async () => {
      const { error: upErr } = await supabase
        .from('reservations')
        .update({ planned_delivery: inp.value || null })
        .eq('id', inp.dataset.resId);
      if (upErr) return toastError('Nie udało się zapisać planowanej dostawy', upErr);
      toast('Zapisano planowaną dostawę.', 'ok');
    }));
  // staff_status NIGDY nie jest nadpisywany przez sync — ustawia go tylko
  // personel (FEATURES_v2 §C). Puste = NULL (status wyliczany automatycznie).
  $$('select[data-res-status]').forEach((sel) =>
    sel.addEventListener('change', async () => {
      const { error: upErr } = await supabase
        .from('reservations')
        .update({ staff_status: sel.value || null })
        .eq('id', sel.dataset.resStatus);
      if (upErr) return toastError('Nie udało się zapisać statusu', upErr);
      toast('Zapisano status personelu.', 'ok');
      renderReservations(); // odśwież status efektywny w kolumnie
    }));
}

// ── Widok: Klienci (odczyt z Optimy + zarządzanie PIN-ami logowania) ────────

/**
 * Wywołanie Edge Function `pin-admin` (kontrakt: DATA_CONTRACT §6).
 * Token sesji staff dokłada się sam (supabase-js), funkcja weryfikuje
 * go po swojej stronie o wiersz w `staff_users`. Na błędzie HTTP
 * FunctionsHttpError niesie odpowiedź w `error.context` (Response).
 */
async function pinAdmin(body) {
  const { data, error } = await supabase.functions.invoke('pin-admin', { body });
  if (error) {
    let payload = null;
    if (typeof error.context?.json === 'function') {
      try { payload = await error.context.json(); } catch { /* body nie-JSON */ }
    }
    throw new Error(payload?.error ?? error.message);
  }
  return data;
}

/**
 * Modal „pokaż raz": PIN jest widoczny wyłącznie teraz — panel nigdzie go
 * nie zapisuje i nie ma żadnej drogi, by go ponownie odczytać.
 */
function openPinModal(customer, pin) {
  const { root } = openModal('PIN wygenerowany', `
    <div class="pin-reveal">
      <p class="pin-for">Klient: <strong>${esc(customer.name)}</strong>${customer.code ? ` <span class="muted">(${esc(customer.code)})</span>` : ''}</p>
      <div class="pin-code">${esc(pin)}</div>
      <button type="button" class="btn btn-primary" id="pin-copy">Kopiuj PIN</button>
      <p class="muted small">Zapisz i przekaż klientowi — nie zobaczysz go ponownie.</p>
    </div>`);
  $('#pin-copy', root).addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pin);
      toast('PIN skopiowany do schowka.', 'ok');
    } catch {
      toast('Nie udało się skopiować — przepisz PIN ręcznie.');
    }
  });
}

async function renderCustomers() {
  const view = $('#view');
  const token = ++viewToken;
  view.innerHTML = loadingHtml();

  const [custRes, pinsRes, catRes, devRes] = await Promise.all([
    supabase
      .from('customers')
      .select('id, code, name, nip, phone, segment, price_level, is_active, customer_users(count)')
      .order('name')
      .limit(2000),
    // Staff SELECT na customer_pins (RLS); join po stronie klienta.
    supabase.from('customer_pins').select('customer_id, pin_set_at'),
    // Widoczność kategorii per klient (FEATURES_v2 §B) — staff pełny CRUD.
    supabase.from('customer_categories').select('customer_id, category'),
    // Aktywne urządzenia (FEATURES_v2 §A) — staff SELECT; join po stronie klienta.
    supabase
      .from('customer_devices')
      .select('customer_id, label, bound_at')
      .eq('is_active', true)
      .order('bound_at', { ascending: false }),
  ]);
  if (token !== viewToken) return;
  if (custRes.error) {
    view.innerHTML = errorHtml();
    return toastError('Błąd pobierania klientów', custRes.error);
  }
  const data = custRes.data;

  // Gdy odczyt statusów PIN zawiedzie, nie zgadujemy stanu — kolumna pokazuje
  // „—" i akcje PIN są schowane (Generuj vs Resetuj zależy od tego stanu).
  let pins = null;
  if (pinsRes.error) toastError('Nie udało się pobrać statusów PIN', pinsRes.error);
  else pins = new Map(pinsRes.data.map((p) => [p.customer_id, p.pin_set_at]));

  // Kategorie: customer_id → Set(category). Błąd = pusta mapa (checkboxy odbite).
  const categories = new Map();
  if (catRes.error) toastError('Nie udało się pobrać kategorii klientów', catRes.error);
  else {
    for (const row of catRes.data) {
      let set = categories.get(row.customer_id);
      if (!set) { set = new Set(); categories.set(row.customer_id, set); }
      set.add(row.category);
    }
  }

  // Urządzenia: customer_id → [{label, bound_at}]. Null = odczyt zawiódł
  // (kolumna „—", przycisk odblokowania schowany, bo nie znamy stanu).
  let devices = null;
  if (devRes.error) toastError('Nie udało się pobrać urządzeń klientów', devRes.error);
  else {
    devices = new Map();
    for (const row of devRes.data) {
      const list = devices.get(row.customer_id);
      if (list) list.push(row);
      else devices.set(row.customer_id, [row]);
    }
  }

  view.innerHTML = `
    <header class="view-head">
      <h1>Klienci</h1>
      <input type="search" id="cust-search" class="search-input" placeholder="Filtruj (nazwa, kod, NIP)…">
    </header>
    <p class="muted small">Dane klientów płyną z Optimy (tylko odczyt). W panelu zarządzasz PIN-ami logowania, widocznymi kategoriami cennika i autoryzacją urządzeń.</p>
    <div id="cust-table"></div>`;

  const pinCell = (c) => {
    if (!pins) return '<span class="muted">—</span>';
    const setAt = pins.get(c.id);
    return setAt
      ? `<span class="badge badge--ok">ustawiony ${esc(fmtDate(setAt))}</span>`
      : '<span class="muted">brak</span>';
  };

  // Akcje tylko dla aktywnych klientów z numerem telefonu (klucz logowania).
  const pinActions = (c) => {
    if (!pins || !c.is_active || !c.phone) return '';
    return pins.has(c.id)
      ? `<button type="button" class="btn btn-ghost" data-pin-set="${esc(c.id)}">Resetuj PIN</button>
         <button type="button" class="btn btn-ghost btn-danger" data-pin-revoke="${esc(c.id)}">Cofnij PIN</button>`
      : `<button type="button" class="btn btn-ghost" data-pin-set="${esc(c.id)}">Generuj PIN</button>`;
  };

  // 4 checkboxy kategorii — „co widzi ten klient" w cenniku. Produkty
  // `default_visible` widzi każdy niezależnie od tych nadań (widok Katalog).
  const categoryChecks = (c) => {
    const set = categories.get(c.id);
    return `<div class="cat-checks">${CATEGORIES.map((cat) => `
      <label class="cat-check">
        <input type="checkbox" data-cat-customer="${esc(c.id)}" data-cat-value="${cat}" ${set?.has(cat) ? 'checked' : ''}>
        <span>${esc(CATEGORY_LABELS[cat])}</span>
      </label>`).join('')}</div>`;
  };

  // Aktywne urządzenie(-a): etykieta + data związania, albo „brak".
  const deviceCell = (c) => {
    if (!devices) return '<span class="muted">—</span>';
    const list = devices.get(c.id) ?? [];
    if (list.length === 0) return '<span class="muted">brak</span>';
    return list.map((d) => `
      <div class="device-line">
        <strong>${esc(d.label || 'Urządzenie')}</strong>
        <span class="muted small">${esc(fmtDate(d.bound_at))}</span>
      </div>`).join('');
  };

  // PIN-y + odblokowanie urządzeń w jednej kolumnie akcji.
  const rowActions = (c) => {
    const parts = [pinActions(c)];
    if ((devices?.get(c.id)?.length ?? 0) > 0) {
      parts.push(`<button type="button" class="btn btn-ghost btn-danger" data-devices-unlock="${esc(c.id)}">Odblokuj urządzenia</button>`);
    }
    return parts.filter(Boolean).join(' ');
  };

  // Zaznaczenie/odznaczenie kategorii = upsert/delete wiersza customer_categories.
  // Optymistycznie: przy błędzie cofamy stan checkboxa.
  async function onCategoryToggle(cb) {
    const customerId = cb.dataset.catCustomer;
    const category = cb.dataset.catValue;
    const checked = cb.checked;
    cb.disabled = true;
    try {
      if (checked) {
        const { error } = await supabase
          .from('customer_categories')
          .upsert({ customer_id: customerId, category }, { onConflict: 'customer_id,category', ignoreDuplicates: true });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('customer_categories')
          .delete()
          .eq('customer_id', customerId)
          .eq('category', category);
        if (error) throw error;
      }
      let set = categories.get(customerId);
      if (!set) { set = new Set(); categories.set(customerId, set); }
      if (checked) set.add(category); else set.delete(category);
    } catch (err) {
      cb.checked = !checked; // rollback widoku do stanu bazy
      toastError('Nie udało się zapisać kategorii', err);
    } finally {
      cb.disabled = false;
    }
  }

  async function onDevicesUnlock(btn) {
    const c = data.find((x) => x.id === btn.dataset.devicesUnlock);
    if (!c) return;
    if (!confirm(`Odblokować urządzenia klienta „${c.name}"? Wszystkie obecne urządzenia zostaną dezaktywowane — przy następnym logowaniu PIN-em klient zwiąże urządzenie od nowa.`)) return;
    btn.disabled = true;
    try {
      await pinAdmin({ action: 'unlock_devices', customer_id: c.id });
      toast('Urządzenia odblokowane.', 'ok');
      renderCustomers();
    } catch (err) {
      btn.disabled = false;
      toastError('Nie udało się odblokować urządzeń', err);
    }
  }

  async function onPinSet(btn) {
    const c = data.find((x) => x.id === btn.dataset.pinSet);
    if (!c) return;
    const isReset = pins?.has(c.id);
    if (isReset && !confirm(`Wygenerować nowy PIN dla „${c.name}"? Dotychczasowy PIN natychmiast przestanie działać.`)) return;
    btn.disabled = true;
    try {
      const res = await pinAdmin({ action: 'set', customer_id: c.id });
      openPinModal(c, res.pin);
      renderCustomers(); // odśwież kolumnę PIN; modal żyje w #modal-root
    } catch (err) {
      btn.disabled = false;
      toastError('Nie udało się wygenerować PIN-u', err);
    }
  }

  async function onPinRevoke(btn) {
    const c = data.find((x) => x.id === btn.dataset.pinRevoke);
    if (!c) return;
    if (!confirm(`Cofnąć PIN dla „${c.name}"? Klient nie zaloguje się do czasu wygenerowania nowego PIN-u.`)) return;
    btn.disabled = true;
    try {
      await pinAdmin({ action: 'revoke', customer_id: c.id });
      toast('PIN cofnięty.', 'ok');
      renderCustomers();
    } catch (err) {
      btn.disabled = false;
      toastError('Nie udało się cofnąć PIN-u', err);
    }
  }

  function renderTable(filterText) {
    const q = filterText.trim().toLowerCase();
    const rows = q
      ? data.filter((c) => `${c.name ?? ''} ${c.code ?? ''} ${c.nip ?? ''}`.toLowerCase().includes(q))
      : data;
    const tableEl = $('#cust-table');
    tableEl.innerHTML = rows.length === 0
      ? emptyHtml(q ? 'Brak klientów pasujących do filtra.' : 'Brak klientów.')
      : `<div class="table-wrap">
          <table>
            <thead><tr>
              <th>Kod</th><th>Nazwa</th><th>NIP</th><th>Telefon</th><th>Segment</th>
              <th>Poziom cen</th><th>Aktywny</th><th>Widoczne kategorie</th>
              <th>Konto w aplikacji</th><th>PIN</th><th>Urządzenie</th><th></th>
            </tr></thead>
            <tbody>${rows.map((c) => `
              <tr>
                <td class="nowrap">${esc(c.code ?? '—')}</td>
                <td><strong>${esc(c.name)}</strong></td>
                <td class="nowrap">${esc(c.nip ?? '—')}</td>
                <td class="nowrap">${esc(c.phone ?? '—')}</td>
                <td>${esc(SEGMENT_LABELS[c.segment] ?? c.segment ?? '—')}</td>
                <td>${esc(c.price_level)}</td>
                <td><span class="badge ${c.is_active ? 'badge--ok' : 'badge--muted'}">${c.is_active ? 'Tak' : 'Nie'}</span></td>
                <td>${categoryChecks(c)}</td>
                <td>${(c.customer_users?.[0]?.count ?? 0) > 0
                    ? '<span class="badge badge--info">Powiązane</span>'
                    : '<span class="muted">brak</span>'}</td>
                <td class="nowrap">${pinCell(c)}</td>
                <td>${deviceCell(c)}</td>
                <td class="row-actions">${rowActions(c)}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>`;
    $$('[data-pin-set]', tableEl).forEach((b) =>
      b.addEventListener('click', () => onPinSet(b)));
    $$('[data-pin-revoke]', tableEl).forEach((b) =>
      b.addEventListener('click', () => onPinRevoke(b)));
    $$('[data-cat-customer]', tableEl).forEach((cb) =>
      cb.addEventListener('change', () => onCategoryToggle(cb)));
    $$('[data-devices-unlock]', tableEl).forEach((b) =>
      b.addEventListener('click', () => onDevicesUnlock(b)));
  }

  renderTable('');
  $('#cust-search').addEventListener('input', (e) => renderTable(e.target.value));
}

// ── Widok: Katalog — widoczność produktów (FEATURES_v2 §B) ──────────────────
// Przełącznik products.default_visible: „produkt podstawowy" widzi KAŻDY klient
// bez dodatkowych nadań kategorii. Pozostałe produkty klient widzi tylko, gdy
// personel nada mu kategorię (widok Klienci).
function catalogProductRow(p) {
  return `
    <tr>
      <td><strong>${esc(p.name)}</strong></td>
      <td class="nowrap">${esc(p.code)}</td>
      <td>${esc(CATEGORY_LABELS[p.category] ?? p.category ?? '—')}</td>
      <td><label class="check"><input type="checkbox" data-vis-id="${esc(p.id)}" ${p.default_visible ? 'checked' : ''}> Podstawowy</label></td>
    </tr>`;
}

function catalogProductTable(products, emptyMsg) {
  if (!products || products.length === 0) return emptyHtml(emptyMsg);
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Nazwa</th><th>Kod</th><th>Kategoria</th><th>Widoczność</th></tr></thead>
        <tbody>${products.map(catalogProductRow).join('')}</tbody>
      </table>
    </div>`;
}

async function renderCatalog() {
  const view = $('#view');
  ++viewToken;
  // Szkielet ustawiamy synchronicznie — helpery piszą tylko do swoich kontenerów,
  // a przy zmianie widoku te kontenery znikają (null-check chroni przed wyścigiem).
  view.innerHTML = `
    <header class="view-head"><h1>Katalog — widoczność</h1></header>
    <p class="muted small">Produkty „podstawowe" widzi KAŻDY klient bez nadawania kategorii. Pozostałe produkty klient widzi tylko po nadaniu mu kategorii w widoku Klienci.</p>
    <section class="card">
      <h2>Znajdź produkt</h2>
      <input type="search" id="cat-search" class="search-input" placeholder="Szukaj produktu (nazwa lub kod)…" autocomplete="off">
      <div id="cat-search-results"></div>
    </section>
    <h2 class="section-title">Produkty podstawowe (widoczne dla wszystkich)</h2>
    <div id="cat-basics">${loadingHtml()}</div>`;

  // Przełączenie widoczności z rollbackiem checkboxa przy błędzie.
  function attachVisToggles(container) {
    $$('[data-vis-id]', container).forEach((cb) =>
      cb.addEventListener('change', async () => {
        const id = cb.dataset.visId;
        const val = cb.checked;
        cb.disabled = true;
        const { error } = await supabase
          .from('products')
          .update({ default_visible: val })
          .eq('id', id);
        cb.disabled = false;
        if (error) {
          cb.checked = !val;
          return toastError('Nie udało się zmienić widoczności', error);
        }
        toast(val ? 'Produkt oznaczony jako podstawowy.' : 'Produkt usunięty z podstawowych.', 'ok');
        refreshBasics();
      }));
  }

  async function refreshBasics() {
    const basicsEl = $('#cat-basics');
    if (!basicsEl) return; // widok zmieniony w międzyczasie
    const { data, error } = await supabase
      .from('products')
      .select('id, code, name, category, default_visible')
      .eq('default_visible', true)
      .order('name')
      .limit(500);
    if (!$('#cat-basics')) return;
    if (error) {
      basicsEl.innerHTML = errorHtml();
      return toastError('Błąd pobierania produktów podstawowych', error);
    }
    basicsEl.innerHTML = catalogProductTable(data, 'Brak produktów podstawowych — użyj wyszukiwarki, aby dodać.');
    attachVisToggles(basicsEl);
  }

  const runSearch = debounce(async () => {
    const resultsEl = $('#cat-search-results');
    if (!resultsEl) return;
    const qStr = $('#cat-search').value.trim();
    if (qStr.length < 2) { resultsEl.innerHTML = ''; return; }
    const pat = ilikePattern(qStr);
    const { data, error } = await supabase
      .from('products')
      .select('id, code, name, category, default_visible')
      .or(`name.ilike.${pat},code.ilike.${pat}`)
      .order('name')
      .limit(30);
    if (!$('#cat-search-results')) return;
    if (error) return toastError('Błąd wyszukiwania produktów', error);
    resultsEl.innerHTML = catalogProductTable(data, 'Brak wyników.');
    attachVisToggles(resultsEl);
  });

  $('#cat-search').addEventListener('input', runSearch);
  refreshBasics();
}

// ── Widok: Synchronizacja ───────────────────────────────────────────────────
// Najświeższy synced_at/updated_at per tabela — wskazówka, nie alarm:
// delta sync odświeża znaczniki tylko przy realnych zmianach danych.
const SYNC_HEALTH = [
  { table: 'customers', column: 'synced_at', label: 'Kontrahenci' },
  { table: 'products', column: 'synced_at', label: 'Towary' },
  { table: 'product_prices', column: 'updated_at', label: 'Ceny' },
  { table: 'stock', column: 'updated_at', label: 'Stany magazynowe' },
  { table: 'reservations', column: 'synced_at', label: 'Rezerwacje' },
];

function healthClass(iso) {
  if (!iso) return 'health--stale';
  const min = (Date.now() - new Date(iso).getTime()) / 60000;
  if (min < 60) return 'health--fresh';
  if (min < 24 * 60) return 'health--warn';
  return 'health--stale';
}

function fmtSyncTables(tables) {
  if (!tables) return '—';
  if (Array.isArray(tables)) return tables.join(', ');
  if (typeof tables === 'object') {
    return Object.entries(tables).map(([k, v]) => `${k}: ${v}`).join(', ');
  }
  return String(tables);
}

async function renderSync() {
  const view = $('#view');
  const token = ++viewToken;
  view.innerHTML = loadingHtml();

  const [runsRes, ...healthRes] = await Promise.all([
    supabase.from('sync_runs').select('*').order('started_at', { ascending: false }).limit(20),
    ...SYNC_HEALTH.map((h) =>
      supabase.from(h.table).select(h.column).order(h.column, { ascending: false, nullsFirst: false }).limit(1)),
  ]);
  if (token !== viewToken) return;
  if (runsRes.error) {
    view.innerHTML = errorHtml();
    return toastError('Błąd pobierania historii synchronizacji', runsRes.error);
  }

  const healthCards = SYNC_HEALTH.map((h, i) => {
    const res = healthRes[i];
    const ts = res.error ? null : res.data?.[0]?.[h.column] ?? null;
    return `
      <div class="health ${healthClass(ts)}">
        <strong>${esc(h.label)}</strong>
        <span>${esc(fmtAgo(ts))}</span>
        <span class="muted small">${esc(fmtDateTime(ts))}</span>
      </div>`;
  }).join('');

  const runs = runsRes.data;
  view.innerHTML = `
    <header class="view-head"><h1>Synchronizacja</h1></header>
    <h2 class="section-title">Świeżość danych (ostatnia zmiana per tabela)</h2>
    <div class="health-grid">${healthCards}</div>
    <h2 class="section-title">Ostatnie przebiegi (20)</h2>
    ${runs.length === 0 ? emptyHtml('Brak zarejestrowanych przebiegów synchronizacji.') : `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Start</th><th>Czas</th><th>Wiersze</th><th>Tabele</th><th>Źródło</th><th>Status</th>
          </tr></thead>
          <tbody>${runs.map((r) => `
            <tr>
              <td class="nowrap">${esc(fmtDateTime(r.started_at))}</td>
              <td class="nowrap">${esc(fmtDuration(r.started_at, r.finished_at))}</td>
              <td class="nowrap">${esc(r.rows_upserted ?? '—')}</td>
              <td class="cell-wide small">${esc(fmtSyncTables(r.tables))}</td>
              <td class="nowrap small">${esc(r.source ?? '—')}</td>
              <td>
                <span class="badge ${r.ok ? 'badge--ok' : 'badge--danger'}">${r.ok ? 'OK' : 'Błąd'}</span>
                ${r.error ? `<div class="muted small">${esc(r.error)}</div>` : ''}
              </td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`}`;
}

// ── Start ───────────────────────────────────────────────────────────────────
init();
