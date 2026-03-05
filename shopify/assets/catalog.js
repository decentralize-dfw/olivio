import * as THREE                     from 'three';
import { OrbitControls }              from 'three/addons/controls/OrbitControls.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import TWEEN                          from 'three/addons/libs/tween.module.js';

const THUMBNAIL_WIDTH = 200;
const IMAGE_WIDTH     = 1200;

// ── Global swatch image map (color_name.toLowerCase() → swatch_image url) ──
// Built from product data after load; replaces hard-coded COLOR_MAP + colorCSS
let swatchImageMap = {};

// ── Helpers ───────────────────────────────────────────────────────────
function shopifyImg(url, w) {
  if (!url) return '';
  try { const u = new URL(url); u.searchParams.set('width', String(w)); return u.toString(); }
  catch { return url + (url.includes('?') ? '&' : '?') + 'width=' + w; }
}

const esc = s => String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// Normalise a product from v4.2 flat JSON to a consistent internal shape
function normaliseProduct(raw) {
  const attr    = raw.attributes           || {};
  const pol     = raw.polarisation_summary || {};
  const imgs    = Array.isArray(raw.images?.all) ? raw.images.all
                : (raw.images ? Object.values(raw.images)[0] || [] : []);
  const col     = raw.collection_positions || {};
  const allCols = col.all_collections      || {};

  // Description: tabs.description.content_text is the real product description in v4.2
  const descFallback = raw.tabs?.description?.content_text
    || (typeof raw.description === 'string'
        ? raw.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
        : '');

  // Product type: merge Shield Sunglasses → Sunglasses (shield IS a shape, not a type)
  let productType = attr.product_type || 'Other';
  if (productType === 'Shield Sunglasses') productType = 'Sunglasses';

  // Color: attributes.extracted_color is reliable in v4.2 — no title-stripping needed
  const color = attr.extracted_color || null;
  const title = raw.title || '';

  // _base: title with color stripped from end (used for sibling grouping)
  const _base = color
    ? title.slice(0, title.toLowerCase().lastIndexOf(color.toLowerCase())).trim()
    : title.trim();

  // Stock: derived from variants (v4.2 has no top-level available field)
  const variants = raw.variants || [];
  const available = variants.length > 0
    ? variants.some(v => v.available !== false)
    : true;

  // Price: v4.2 price object uses .min / .max / .amount
  const priceMin = parseFloat(raw.price?.min    ?? raw.price?.amount ?? 0) || 0;
  const priceMax = parseFloat(raw.price?.max    ?? raw.price?.amount ?? 0) || 0;
  const price    = priceMin || parseFloat(raw.price?.amount ?? 0) || 0;

  // Polarisation: pol.status (not pol.polarisation_status — that field doesn't exist)
  const polStatus    = pol.status       || 'unknown';
  const isSwitchable = pol.is_switchable || false;

  // Collections
  const isBestSeller      = 'best-seller' in allCols;
  const bestSellerPos     = isBestSeller ? (allCols['best-seller']?.position ?? 9999) : 9999;
  const isFeatured        = 'news-2025' in allCols || col.is_featured === true;
  const collectionHandles = Object.keys(allCols);

  return {
    id:          raw.id,
    title,
    url:         raw.url || '#',
    price,
    priceMin,
    priceMax,
    images:      imgs,
    age:         attr.age_group   || null,
    shape:       attr.frame_shape || null,
    productType,
    color,
    available,
    polStatus,
    isSwitchable,
    variants,
    tabs:        raw.tabs || {},
    descFallback,
    swatches:    raw.color_swatches || [],
    recos:       raw.recommendations?.you_may_also_like || [],
    isBestSeller,
    bestSellerPos,
    isFeatured,
    collectionHandles,
    _base,
  };
}

// ── State ─────────────────────────────────────────────────────────────
const state = {
  view:  'grid',
  group: 'all',
  search: '',
  paramAge: null,   // set from ?age= URL param
  ticks: {
    age: new Set(), shape: new Set(), type: new Set(),
    lens: new Set(), stock: new Set(), collection: new Set()
  }
};

let camera, scene, renderer, controls;
let objects = [], labels = [];
let isDragging = false, autoRotateSpeed = 0, globalRotation = 0;
let products = [], colorSiblings = {}, productById = {};
let flowPaused = false;

// ── Data load ─────────────────────────────────────────────────────────
const DB_URL = window.CATALOG_DB_URL || 'https://decentralize-dfw.github.io/olivio/olivio_database_v4.json';

fetch(DB_URL)
  .then(r => r.json())
  .then(data => {
    const raw = Array.isArray(data) ? data : (data.products || Object.values(data));
    products = raw.map(normaliseProduct);

    // Build global swatch image map (color_name.toLowerCase() → swatch_image url)
    swatchImageMap = {};
    for (const p of products) {
      for (const sw of p.swatches) {
        if (sw.color_name && sw.swatch_image) {
          swatchImageMap[sw.color_name.toLowerCase()] = sw.swatch_image;
        }
      }
    }

    // Build color siblings by base key (title minus color name)
    colorSiblings = {};
    for (const p of products) {
      if (!colorSiblings[p._base]) colorSiblings[p._base] = [];
      colorSiblings[p._base].push(p);
    }

    // Build product lookup by id for recommendations (module-scoped)
    productById = {};
    for (const p of products) productById[p.id] = p;

    init();
    animate();

    // Apply URL params (e.g. ?collection=creative-d&age=kids&type=ski)
    (function applyUrlParams() {
      const params = new URLSearchParams(window.location.search);
      const collectionMap = {
        'creative-d':    'creative-edition-d',
        'coral-reef':    'coral-reef',
        'citrus-garden': 'citrus-graden',
        'greenhouse':    'greenhouse-sunglasses',
        'deep-sea':      'deepseasunglasses',
        'olympia':       'olympia',
        'classic':       'classicsunglasses',
        'ski-goggles':   'ski-goggles',
        'screen':        'screenglasses',
        'sport':         'sport-sunglasses',
        'creative-shield':'creative-shield',
        'breakfast-art': 'breakfast-art',
      };
      const ageMap = {
        'baby':    'Baby',
        'toddler': 'Toddler',
        'kids':    'Kids',
        'junior':  'Junior',
        'teen':    'Teen & Adult',
        'adult':   'Teen & Adult',
      };
      const typeMap = {
        'ski':        'Ski Goggles',
        'screen':     'Screen Glasses',
        'sport':      'Sports Sunglasses',
        'sunglasses': 'Sunglasses',
      };
      let changed = false;
      const col = params.get('collection');
      if (col && collectionMap[col]) { state.ticks.collection.add(collectionMap[col]); changed = true; }
      const age = params.get('age');
      if (age && ageMap[age]) { state.paramAge = ageMap[age]; changed = true; }
      const type = params.get('type');
      if (type && typeMap[type]) { state.ticks.type.add(typeMap[type]); changed = true; }
      if (changed) { updateLayout(); scheduleAutoFit(); }
    })();

    const l = document.getElementById('loader');
    l.style.opacity = '0';
    setTimeout(() => l.remove(), 400);
  })
  .catch(err => {
    console.error(err);
    document.getElementById('loader-sub').textContent = 'Failed to load — check network.';
  });

// ── Three.js init ─────────────────────────────────────────────────────
function init() {
  const container = document.getElementById('container');
  const FRUST = 3500, aspect = window.innerWidth / window.innerHeight;

  camera = new THREE.OrthographicCamera(
    FRUST*aspect/-2, FRUST*aspect/2, FRUST/2, FRUST/-2, 1, 15000
  );
  camera.position.set(2000, 1000, 2000);
  camera.lookAt(0, 0, 0);

  scene    = new THREE.Scene();
  renderer = new CSS3DRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.style.position = 'absolute';
  renderer.domElement.style.top = '0';
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.05;
  controls.minZoom = 0.04; controls.maxZoom = 6;
  controls.minPolarAngle = 0.05; controls.maxPolarAngle = Math.PI - 0.05;

  window.addEventListener('mousedown',  () => { isDragging = true; });
  window.addEventListener('mouseup',    () => { isDragging = false; });
  window.addEventListener('touchstart', () => { isDragging = true; }, { passive: true });
  window.addEventListener('touchend',   () => { isDragging = false; }, { passive: true });

  buildScene();
  window.addEventListener('resize', onWindowResize);
  setupMenuButtons();
  setupFilterPopup();
  setupSlider();
  setupFitButton();
  setupModal();
  setupSearch();
  setupCart();
}

// ── Build 3D scene ────────────────────────────────────────────────────
function buildScene() {
  objects.forEach(o => scene.remove(o));
  objects = [];

  for (let idx = 0; idx < products.length; idx++) {
    const p = products[idx];

    // Outer wrapper: CSS3DRenderer owns this element's transform
    const wrap = document.createElement('div');
    wrap.className = 'card-wrap';

    // Inner card: we control its scale for show/hide
    const el = document.createElement('div');
    el.className = 'element-card';

    const img = document.createElement('img');
    img.src = p.images?.[0] ? shopifyImg(p.images[0], THUMBNAIL_WIDTH) : '';
    img.draggable = false; img.loading = 'eager';
    el.appendChild(img);
    wrap.appendChild(el);

    el.addEventListener('mouseenter', () => {
      if (state.view === 'flow') flowPaused = true;
      else if (!isDragging) controls.enabled = false;
      showTooltip(p.title);
    });
    el.addEventListener('mouseleave', () => {
      if (state.view === 'flow') flowPaused = false;
      else controls.enabled = true;
      hideTooltip();
    });
    el.addEventListener('click', e => { e.stopPropagation(); openModal(p); });

    const sx = (Math.random()-.5)*1400, sy = (Math.random()-.5)*1400, sz = (Math.random()-.5)*1400;
    const obj = new CSS3DObject(wrap);
    obj.position.set(sx, sy, sz);
    obj.userData = {
      active:       true,
      cardEl:       el,       // inner element we scale
      center:       new THREE.Vector3(0, 0, 0),
      offset:       new THREE.Vector3(sx, sy, sz),
      rotation:     new THREE.Euler(0, 0, 0),
      sphereCenter: null,
      flowX: (Math.random()-.5)*1800,
      flowY: (Math.random()-.5)*1100,
      flowZ: -2000 - Math.random()*6000,
      flowSpeed: 5 + Math.random()*12,
    };
    scene.add(obj);
    objects.push(obj);
  }

  updateLayout();
}

// ── Tooltip ───────────────────────────────────────────────────────────
function showTooltip(text) {
  const t = document.getElementById('hover-tooltip');
  if (t) { t.textContent = text; t.classList.add('visible'); }
}
function hideTooltip() {
  const t = document.getElementById('hover-tooltip');
  if (t) { t.textContent = ''; t.classList.remove('visible'); }
}

// ── Group key ─────────────────────────────────────────────────────────
function groupKey(i) {
  const p = products[i];
  switch (state.group) {
    case 'age':   return p.age         || 'Other';
    case 'shape': {
      // Display-friendly shape label
      const s = p.shape;
      if (!s) return 'Other';
      if (s === 'D-Frame') return '#D';
      return s;
    }
    case 'type':  return p.productType || 'Other';
    case 'lens':  return p.polStatus === 'polarised_only'     ? 'Polarised'
                       : p.polStatus === 'non_polarised_only' ? 'Non-Polarised'
                       : p.polStatus === 'switchable'         ? 'Switchable'
                       : 'Other';
    default: return '__ALL__';
  }
}

// ── Visible indices (filters, search; no filtering in flow) ───────────
function visibleIndices() {
  if (state.view === 'flow') return products.map((_, i) => i);

  const q = state.search.toLowerCase().trim();

  let indices = products.map((_, i) => i).filter(i => {
    const p = products[i];

    // Search
    if (q && !p.title.toLowerCase().includes(q) && !(p.color||'').toLowerCase().includes(q)) return false;

    const ta = state.ticks.age;
    if (ta.size > 0 && !ta.has(p.age || 'Other')) return false;

    const ts = state.ticks.shape;
    if (ts.size > 0 && !ts.has(p.shape || 'Other')) return false;

    const tt = state.ticks.type;
    if (tt.size > 0 && !tt.has(p.productType || 'Other')) return false;

    const tl = state.ticks.lens;
    if (tl.size > 0) {
      const s = p.polStatus;
      const matchesPolar    = tl.has('Polarised')     && (s === 'polarised_only'     || s === 'switchable');
      const matchesNonPolar = tl.has('Non-Polarised') && (s === 'non_polarised_only' || s === 'switchable');
      const matchesOther    = tl.has('__other__')     && (s === 'unknown');
      if (!matchesPolar && !matchesNonPolar && !matchesOther) return false;
    }

    const tk = state.ticks.stock;
    if (tk.has('in') && !p.available) return false;

    const tc = state.ticks.collection;
    if (tc.size > 0) {
      const wantFeat = tc.has('featured');
      const wantBest = tc.has('bestseller');
      // Named collection handles (e.g. 'creative-edition-d', 'coral-reef')
      const namedHandles = [...tc].filter(v => v !== 'featured' && v !== 'bestseller');
      const matchFeat    = wantFeat && p.isFeatured;
      const matchBest    = wantBest && p.isBestSeller;
      const matchHandle  = namedHandles.length > 0 && namedHandles.some(h => p.collectionHandles.includes(h));
      if (!matchFeat && !matchBest && !matchHandle) return false;
    }

    // URL-param age filter (separate from tick UI, stored in state.paramAge)
    if (state.paramAge && p.age !== state.paramAge) return false;

    return true;
  });

  // Sort by best-seller position when that filter is active (and no other collection filter)
  if (state.ticks.collection.has('bestseller') && !state.ticks.collection.has('featured')) {
    indices.sort((a, b) => products[a].bestSellerPos - products[b].bestSellerPos);
  }

  return indices;
}

// ── Labels ────────────────────────────────────────────────────────────
function removeLabels() {
  const old = [...labels]; labels = [];
  old.forEach(l => {
    if (l.element) l.element.classList.remove('visible');
    setTimeout(() => scene.remove(l), 800);
  });
}
function createLabel(text, sub, x, y, z) {
  const wrap = document.createElement('div'); wrap.className = 'group-label-wrap';
  const main = document.createElement('div'); main.className = 'group-label-main'; main.textContent = text;
  wrap.appendChild(main);
  if (sub) {
    const s = document.createElement('div'); s.className = 'group-label-sub'; s.textContent = sub;
    wrap.appendChild(s);
  }
  const obj = new CSS3DObject(wrap);
  obj.position.set(x, y, z);
  scene.add(obj); labels.push(obj);
  setTimeout(() => wrap.classList.add('visible'), 50);
}

// ── Layout update ─────────────────────────────────────────────────────
function updateLayout() {
  TWEEN.removeAll();
  removeLabels();
  objects.forEach(o => { o.userData.rotation.set(0,0,0); o.userData.sphereCenter = null; });

  const visible = new Set(visibleIndices());

  // Hide items that should not be visible — scale to 0 in place
  objects.forEach((obj, i) => {
    if (!visible.has(i)) {
      if (obj.userData.active) {
        obj.userData.active = false;
        const el = obj.userData.cardEl;
        el.classList.remove('showing');
        el.classList.add('hiding');
        setTimeout(() => { if (!obj.userData.active) el.style.pointerEvents = 'none'; }, 380);
      } else {
        obj.userData.cardEl.style.transform = 'scale(0)';
        obj.userData.cardEl.style.pointerEvents = 'none';
      }
    }
  });

  // Build groups for visible items
  const groups = {};
  for (const i of visible) {
    const k = groupKey(i);
    if (!groups[k]) groups[k] = [];
    groups[k].push(i);
  }

  const isGrouped = ['age','shape','type','lens'].includes(state.group);
  const groupKeys = Object.keys(groups).sort();
  const ITEM_SPC  = 185, LABEL_Y = 900;

  document.getElementById('count-badge').textContent =
    visible.size + ' product' + (visible.size !== 1 ? 's' : '');

  groupKeys.forEach((key, gIdx) => {
    const idxs = groups[key];
    let cx = 0, cy = 0, cz = 0;
    const sphereR    = Math.max(Math.sqrt(idxs.length)*65, 200);
    const clusterSpc = Math.max(2400, (groupKeys.length*1300)/(Math.PI*2));

    if (isGrouped) {
      if (state.view === 'grid') {
        const zSpc = 2600, totalZ = (groupKeys.length-1)*zSpc;
        cz = (totalZ/2) - (gIdx*zSpc);
      } else {
        const angle = (gIdx/groupKeys.length)*Math.PI*2;
        cx = Math.cos(angle)*clusterSpc; cz = Math.sin(angle)*clusterSpc;
      }
      createLabel(key, state.group.toUpperCase(), cx, LABEL_Y, cz);
    }

    if (state.view === 'grid') {
      const cols = Math.ceil(Math.sqrt(idxs.length));
      idxs.forEach((objIdx, i) => {
        const obj = objects[objIdx];
        const wasActive = obj.userData.active;
        obj.userData.active = true;
        const ox = (i%cols - (cols-1)/2)*ITEM_SPC, oy = 420 - Math.floor(i/cols)*ITEM_SPC;

        // Tween position
        new TWEEN.Tween(obj.userData.center).to({x:cx,y:cy,z:cz},2300).easing(TWEEN.Easing.Exponential.InOut).start();
        new TWEEN.Tween(obj.userData.offset).to({x:ox,y:oy,z:0},2300).easing(TWEEN.Easing.Exponential.InOut).start();
        new TWEEN.Tween(obj.userData.rotation).to({x:0,y:0,z:0},2300).easing(TWEEN.Easing.Exponential.InOut).start();

        // Scale in if newly shown
        if (!wasActive) {
          const el = obj.userData.cardEl;
          el.style.pointerEvents = '';
          el.style.transform = 'scale(0)';
          el.classList.remove('hiding');
          // Small delay so position tween starts first
          setTimeout(() => {
            el.classList.add('showing');
            el.style.transform = 'scale(1)';
            setTimeout(() => el.classList.remove('showing'), 500);
          }, 150);
        } else {
          // Already visible — just remove hiding class if present
          const el = obj.userData.cardEl;
          el.classList.remove('hiding');
          el.style.pointerEvents = '';
          if (!el.style.transform || el.style.transform === 'scale(0)') {
            el.style.transform = 'scale(1)';
          }
        }
      });
    } else { // sphere
      const sphereCY = 420 - sphereR;
      idxs.forEach((objIdx, i) => {
        const obj = objects[objIdx];
        const wasActive = obj.userData.active;
        obj.userData.active = true;
        const phi   = Math.acos(-1+(2*i)/idxs.length), theta = Math.sqrt(idxs.length*Math.PI)*phi;
        const ox    = sphereR*Math.sin(phi)*Math.cos(theta);
        const oy    = sphereR*Math.sin(phi)*Math.sin(theta);
        const oz    = sphereR*Math.cos(phi);
        obj.userData.sphereCenter = new THREE.Vector3(cx, sphereCY, cz);

        new TWEEN.Tween(obj.userData.center).to({x:cx,y:cy,z:cz},2300).easing(TWEEN.Easing.Exponential.InOut).start();
        new TWEEN.Tween(obj.userData.offset).to({x:ox,y:oy+sphereCY,z:oz},2300).easing(TWEEN.Easing.Exponential.InOut).start();
        new TWEEN.Tween(obj.userData.rotation).to({x:0,y:0,z:0},2300).easing(TWEEN.Easing.Exponential.InOut).start();

        if (!wasActive) {
          const el = obj.userData.cardEl;
          el.style.pointerEvents = '';
          el.style.transform = 'scale(0)';
          el.classList.remove('hiding');
          setTimeout(() => {
            el.classList.add('showing');
            el.style.transform = 'scale(1)';
            setTimeout(() => el.classList.remove('showing'), 500);
          }, 150);
        } else {
          const el = obj.userData.cardEl;
          el.classList.remove('hiding');
          el.style.pointerEvents = '';
          if (!el.style.transform || el.style.transform === 'scale(0)') {
            el.style.transform = 'scale(1)';
          }
        }
      });
    }
  });
}

// ── Flow mode — Infinite Tunnel / Warp Speed ──────────────────────────
// Constants
const FLOW_CAM_Z    =  3200;  // camera Z during flow
const FLOW_SPAWN_Z  = -8000;  // cards spawn here (far end of tunnel)
const FLOW_LOOP_Z   =   500;  // cards teleport back when they pass this point
const FLOW_TUNNEL   = FLOW_LOOP_Z - FLOW_SPAWN_Z; // 8500 units total

function enterFlowMode() {
  controls.enabled = false;
  TWEEN.removeAll();

  // Hard-snap camera so the very first frame is perfectly straight-on.
  camera.position.set(0, 0, FLOW_CAM_Z);
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update(); // sync camera lookAt to new target

  // Scatter all cards through the tunnel at startup so the stream is full immediately.
  objects.forEach(obj => {
    obj.userData.active = true;
    obj.userData.flowZ     = FLOW_SPAWN_Z + Math.random() * FLOW_TUNNEL;
    obj.userData.flowX     = (Math.random() - 0.5) * 5000;
    obj.userData.flowY     = (Math.random() - 0.5) * 3000;
    obj.userData.flowSpeed = 30 + Math.random() * 50;
    obj.userData.center.set(0, 0, 0);
    obj.userData.offset.set(0, 0, 0);
    obj.userData.cardEl.classList.add('flow-active');
    obj.userData.cardEl.style.pointerEvents = 'auto';
    obj.userData.cardEl.classList.remove('hiding');
  });

  // Grey-out group + filter buttons during flow
  document.querySelectorAll('.nav-btn[data-type="group"]')
    .forEach(b => b.classList.add('flow-disabled'));
  document.getElementById('filter-toggle-btn').classList.add('flow-disabled');

  document.getElementById('count-badge').textContent = products.length + ' products';
}

function exitFlowMode() {
  // Re-enable orbit control
  controls.enabled = true;
  TWEEN.removeAll();

  // Clear per-card flow state
  objects.forEach(obj => {
    obj.userData.cardEl.classList.remove('flow-active');
    obj.userData.cardEl.style.transform = '';   // reset JS perspective scale
  });

  // Restore camera
  new TWEEN.Tween(camera.position)
    .to({x:2000, y:1000, z:2000}, 900)
    .easing(TWEEN.Easing.Cubic.Out).start();
  new TWEEN.Tween(controls.target)
    .to({x:0, y:0, z:0}, 900)
    .easing(TWEEN.Easing.Cubic.Out).start();

  // Re-enable nav buttons
  document.querySelectorAll('.nav-btn[data-type="group"]')
    .forEach(b => b.classList.remove('flow-disabled'));
  document.getElementById('filter-toggle-btn').classList.remove('flow-disabled');
}

// ── Flat mode ─────────────────────────────────────────────────────────
function buildFlatGrid() {
  const content = document.getElementById('flat-content');
  content.innerHTML = '';

  const visible = visibleIndices();
  const groups  = {};
  for (const i of visible) {
    const k = groupKey(i);
    if (!groups[k]) groups[k] = [];
    groups[k].push(i);
  }

  const isGrouped = state.group !== 'all';
  const groupKeys = Object.keys(groups).sort();

  for (const key of groupKeys) {
    if (isGrouped) {
      const hdr = document.createElement('div');
      hdr.className = 'flat-group-header';
      hdr.textContent = key;
      content.appendChild(hdr);
    }
    const grid = document.createElement('div');
    grid.className = 'flat-grid';

    for (const i of groups[key]) {
      const p    = products[i];
      const card = document.createElement('div');
      card.className = 'flat-card';
      // Random delay so every card scales from its own center simultaneously-ish
      card.style.animationDelay = Math.round(Math.random() * 120) + 'ms';
      const img = document.createElement('img');
      img.src     = p.images?.[0] ? shopifyImg(p.images[0], THUMBNAIL_WIDTH) : '';
      img.loading = 'lazy'; img.alt = '';
      card.appendChild(img);
      card.addEventListener('click', () => openModal(p));
      grid.appendChild(card);
    }
    content.appendChild(grid);
  }

  document.getElementById('count-badge').textContent =
    visible.length + ' product' + (visible.length !== 1 ? 's' : '');
}

// ── Animation loop ────────────────────────────────────────────────────
const _vh = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  TWEEN.update();

  // FLOW mode — Infinite Tunnel / Warp Speed
  if (state.view === 'flow') {
    // OrbitControls intentionally OFF — camera is fixed, illusion must not be broken
    if (!flowPaused) {
      objects.forEach(obj => {
        obj.userData.flowZ += obj.userData.flowSpeed;

        // Card passed camera → teleport back to far end with a fresh lane
        if (obj.userData.flowZ > FLOW_LOOP_Z) {
          obj.userData.flowZ     = FLOW_SPAWN_Z - Math.random() * 1500;
          obj.userData.flowX     = (Math.random() - 0.5) * 5000;
          obj.userData.flowY     = (Math.random() - 0.5) * 3000;
          obj.userData.flowSpeed = 30 + Math.random() * 50;
        }

        obj.position.set(obj.userData.flowX, obj.userData.flowY, obj.userData.flowZ);
        obj.rotation.set(0, 0, 0);

        // Perspective scale: normZ^1.5 * 5 → grows from 0.05 (tiny dot) to 5×
        const normZ = Math.min(1, Math.max(0, (obj.userData.flowZ - FLOW_SPAWN_Z) / FLOW_TUNNEL));
        const scale = Math.max(0.05, Math.pow(normZ, 1.5) * 5);
        obj.userData.cardEl.style.transform = `scale(${scale.toFixed(3)})`;
      });
    }
    renderer.render(scene, camera);
    return;
  }

  // FLAT mode — 3D is behind overlay, skip heavy update
  if (state.view === 'flat') {
    return;
  }

  // Normal 3D modes
  controls.update();
  globalRotation += autoRotateSpeed;

  objects.forEach((obj, i) => {
    if (!obj.userData.active) return; // hidden in place, no update needed

    const off = obj.userData.offset.clone();
    off.applyAxisAngle(new THREE.Vector3(0,1,0), globalRotation);
    const pos = new THREE.Vector3().copy(obj.userData.center).add(off);

    if (state.view === 'sphere') {
      obj.position.copy(pos);
      if (obj.userData.sphereCenter) {
        _vh.subVectors(obj.position, obj.userData.sphereCenter).add(obj.position);
        obj.lookAt(_vh);
      }
    } else { // grid
      obj.position.copy(pos);
      obj.rotation.set(0, globalRotation, 0);
    }
  });

  renderer.render(scene, camera);
}

// ── Menu buttons ──────────────────────────────────────────────────────
function setupMenuButtons() {
  document.querySelectorAll('.nav-btn[data-type]').forEach(btn => {
    btn.addEventListener('click', e => {
      const type = e.currentTarget.dataset.type;
      const val  = e.currentTarget.dataset.val;
      if (state[type] === val) return;

      const prevView = state.view;

      // Sync active state across all nav bars
      document.querySelectorAll(`.nav-btn[data-type="${type}"]`)
        .forEach(b => b.classList.toggle('active', b.dataset.val === val));

      state[type] = val;

      if (type === 'group') {
        // Clear ticks that match old group
        state.ticks.age.clear(); state.ticks.shape.clear();
        state.ticks.type.clear(); state.ticks.lens.clear();
        document.querySelectorAll('.fp-btn[data-cat="age"],.fp-btn[data-cat="shape"],.fp-btn[data-cat="type"],.fp-btn[data-cat="lens"]')
          .forEach(b => b.classList.remove('active'));

        if (state.view === 'flat') buildFlatGrid();
        else if (state.view !== 'flow') { updateLayout(); scheduleAutoFit(); }
        return;
      }

      // ── View transition ──
      // Leave previous
      if (prevView === 'flat') {
        document.getElementById('flat-overlay').style.display = 'none';
        document.getElementById('controls').classList.remove('disabled');
      }
      if (prevView === 'flow') {
        exitFlowMode();
      }

      // Enter new
      if (val === 'flat') {
        document.getElementById('controls').classList.add('disabled');
        buildFlatGrid();
        document.getElementById('flat-overlay').style.display = 'block';
        // Still run updateLayout in background for when user leaves flat
        if (prevView !== 'flow') updateLayout();
      } else if (val === 'flow') {
        enterFlowMode();
      } else {
        // grid or sphere — layout tweens take 2300 ms; fit after they settle
        updateLayout();
        scheduleAutoFit();
      }
    });
  });
}

// ── Filter popup ──────────────────────────────────────────────────────
function setupFilterPopup() {
  const toggleBtn = document.getElementById('filter-toggle-btn');
  const popup     = document.getElementById('filter-popup');
  const arrow     = document.getElementById('filter-arrow');

  toggleBtn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = popup.classList.contains('open');
    popup.classList.toggle('open', !isOpen);
    toggleBtn.classList.toggle('open', !isOpen);
    arrow.textContent = isOpen ? '▾' : '▴';
  });

  // Close on outside click
  document.addEventListener('click', e => {
    if (!document.getElementById('bl-container').contains(e.target)) {
      popup.classList.remove('open');
      toggleBtn.classList.remove('open');
      arrow.textContent = '▾';
    }
  });

  // Filter buttons
  document.querySelectorAll('.fp-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const cat = btn.dataset.cat;
      const val = btn.dataset.val;
      const set = state.ticks[cat];
      if (set.has(val)) { set.delete(val); btn.classList.remove('active'); }
      else              { set.add(val);    btn.classList.add('active');    }
      if      (state.view === 'flat') buildFlatGrid();
      else if (state.view !== 'flow') updateLayout();
    });
  });

  // Reset
  document.getElementById('filter-reset-btn').addEventListener('click', e => {
    e.stopPropagation();
    Object.values(state.ticks).forEach(s => s.clear());
    document.querySelectorAll('.fp-btn').forEach(b => b.classList.remove('active'));
    if      (state.view === 'flat') buildFlatGrid();
    else if (state.view !== 'flow') updateLayout();
  });
}

// ── Slider ────────────────────────────────────────────────────────────
function setupSlider() {
  const slider   = document.getElementById('rotate-slider');
  const label    = document.getElementById('ctrl-label');
  const resetBtn = document.getElementById('rotate-reset-btn');

  slider.addEventListener('input', e => {
    autoRotateSpeed = parseFloat(e.target.value) * 0.02;
    const active = parseFloat(e.target.value) !== 0;
    label.style.display    = active ? 'none'  : '';
    resetBtn.style.display = active ? 'block' : 'none';
  });

  resetBtn.addEventListener('click', () => {
    autoRotateSpeed = 0;
    globalRotation  = 0;
    slider.value = 0;
    label.style.display    = '';
    resetBtn.style.display = 'none';
  });
}

// ── Fit view ──────────────────────────────────────────────────────────
function fitView() {
  if (!camera) return;
  const activePos = [];
  objects.forEach(obj => { if (obj.userData.active) activePos.push(obj.position.clone()); });
  if (activePos.length === 0) return;

  // World-space centroid
  const centroid = new THREE.Vector3();
  activePos.forEach(p => centroid.add(p));
  centroid.divideScalar(activePos.length);

  // Project all positions to camera-local space
  camera.updateMatrixWorld();
  const invCam = new THREE.Matrix4().copy(camera.matrixWorldInverse);

  // Find extents relative to centroid in camera space (so zoom centers on group)
  const centroidCam = centroid.clone().applyMatrix4(invCam);
  let maxExtX = 0, maxExtY = 0;
  activePos.forEach(p => {
    const c = p.clone().applyMatrix4(invCam);
    maxExtX = Math.max(maxExtX, Math.abs(c.x - centroidCam.x));
    maxExtY = Math.max(maxExtY, Math.abs(c.y - centroidCam.y));
  });

  const W = window.innerWidth, H = window.innerHeight;
  const aspect = W / H, FRUST = 3500;
  const pad = (W <= 639 ? 100 : 155) * 1.8;
  const extX = maxExtX + pad;
  const extY = maxExtY + pad;
  const zoomX = (FRUST * aspect) / (2 * extX);
  const zoomY = FRUST / (2 * extY);
  const zoom  = Math.max(0.04, Math.min(Math.min(zoomX, zoomY), 6));

  // Pan camera to centroid (move both camera.position and controls.target by same delta)
  const delta = centroid.clone().sub(controls.target);
  const newCamPos = camera.position.clone().add(delta);

  new TWEEN.Tween(controls.target)
    .to({ x: centroid.x, y: centroid.y, z: centroid.z }, 900)
    .easing(TWEEN.Easing.Cubic.Out).start();
  new TWEEN.Tween(camera.position)
    .to({ x: newCamPos.x, y: newCamPos.y, z: newCamPos.z }, 900)
    .easing(TWEEN.Easing.Cubic.Out).start();
  new TWEEN.Tween(camera)
    .to({ zoom }, 900)
    .easing(TWEEN.Easing.Cubic.Out)
    .onUpdate(() => camera.updateProjectionMatrix())
    .start();
}

// Auto-fit after any layout tween (tweens take 2300 ms)
let _autoFitTimer = null;
function scheduleAutoFit() {
  clearTimeout(_autoFitTimer);
  _autoFitTimer = setTimeout(() => {
    if (state.view !== 'flow' && state.view !== 'flat') fitView();
  }, 2500);
}

function setupFitButton() {
  document.getElementById('fit-btn').addEventListener('click', fitView);
}

// ── Search ─────────────────────────────────────────────────────────────
function setupSearch() {
  const input = document.getElementById('search-input');
  if (!input) return;
  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.search = input.value;
      if      (state.view === 'flat') buildFlatGrid();
      else if (state.view !== 'flow') { updateLayout(); scheduleAutoFit(); }
    }, 120);
  });
  // Prevent drag while typing
  input.addEventListener('mousedown', e => e.stopPropagation());
  input.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
}

function onWindowResize() {
  const FRUST = 3500, aspect = window.innerWidth / window.innerHeight;
  camera.left = -FRUST*aspect/2; camera.right  =  FRUST*aspect/2;
  camera.top  =  FRUST/2;        camera.bottom = -FRUST/2;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ── Modal ─────────────────────────────────────────────────────────────
let _imgs = [];

function setupModal() {
  document.getElementById('modal-close')   .addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', closeModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
}

function openModal(p)  { populateModal(p); document.getElementById('modal-overlay').classList.add('open'); }
function closeModal()  { document.getElementById('modal-overlay').classList.remove('open'); }

// ── Shopify Ajax Cart ────────────────────────────────────────────────

let _activeVariantId = null;

function setCtaVariant(variantUrl) {
  // Extract variant ID from URL (e.g. ?variant=48301797605659)
  let vid = null;
  try {
    const u = new URL(variantUrl, 'https://olivioandco.eu');
    vid = u.searchParams.get('variant');
  } catch(e) {}
  _activeVariantId = vid ? parseInt(vid, 10) : null;
}

function showCartToast(msg, isError = false) {
  const el = document.getElementById('cart-toast');
  if (!el) return;
  el.textContent = msg;
  el.style.background = isError ? '#c00' : '#000';
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3500);
}

async function addToCart(variantId, quantity = 1) {
  console.log('[Cart] addToCart variantId =', variantId);
  if (!variantId) {
    showCartToast('Variant seçilemedi — lütfen tekrar deneyin.', true);
    return;
  }
  const btn = document.getElementById('modal-add-cart');
  if (btn) { btn.textContent = 'Adding…'; btn.disabled = true; }
  try {
    const res = await fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ id: variantId, quantity })
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('[Cart] /cart/add.js error', res.status, body);
      showCartToast('Sepete eklenemedi (' + res.status + ')', true);
      return;
    }
    await refreshCart();
    openCartDrawer();
  } catch(e) {
    console.error('[Cart] addToCart fetch error:', e);
    showCartToast('Bağlantı hatası — Shopify\'da mısınız?', true);
  } finally {
    if (btn) { btn.textContent = 'Add to Cart'; btn.disabled = false; }
  }
}

async function buyNow(variantId, quantity = 1) {
  console.log('[Cart] buyNow variantId =', variantId);
  if (!variantId) {
    showCartToast('Variant seçilemedi — lütfen tekrar deneyin.', true);
    return;
  }
  const btn = document.getElementById('modal-buy-now');
  if (btn) { btn.textContent = 'Processing…'; btn.disabled = true; }
  try {
    const res = await fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ id: variantId, quantity })
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('[Cart] /cart/add.js (buyNow) error', res.status, body);
      showCartToast('İşlem başarısız (' + res.status + ')', true);
      if (btn) { btn.textContent = 'Buy Now →'; btn.disabled = false; }
      return;
    }
    window.location.href = '/checkout';
  } catch(e) {
    console.error('[Cart] buyNow fetch error:', e);
    showCartToast('Bağlantı hatası', true);
    if (btn) { btn.textContent = 'Buy Now →'; btn.disabled = false; }
  }
}

async function refreshCart() {
  try {
    const res = await fetch('/cart.js', { headers: { 'Accept': 'application/json' } });
    const cart = await res.json();
    updateCartCount(cart.item_count);
    renderCartItems(cart);
  } catch(e) { console.error('refreshCart:', e); }
}

function updateCartCount(count) {
  document.querySelectorAll('#cart-count, .cart-count-badge').forEach(el => {
    if (count > 0) { el.textContent = count; el.style.display = ''; }
    else { el.style.display = 'none'; }
  });
  const drawerCount = document.getElementById('cart-drawer-count');
  if (drawerCount) drawerCount.textContent = count;
}

function renderCartItems(cart) {
  const container = document.getElementById('cart-items');
  const emptyMsg  = document.getElementById('cart-empty-msg');
  const subtotal  = document.getElementById('cart-subtotal');
  if (!container) return;

  if (!cart.items || cart.items.length === 0) {
    container.innerHTML = '';
    if (emptyMsg) { emptyMsg.style.display = ''; container.appendChild(emptyMsg); }
    if (subtotal) subtotal.textContent = '€0.00';
    return;
  }
  if (emptyMsg) emptyMsg.style.display = 'none';

  container.innerHTML = cart.items.map(item => `
    <div class="cart-item" data-key="${esc(item.key)}">
      <img class="cart-item-img" src="${esc(item.featured_image?.url || item.image || '')}" alt="${esc(item.product_title)}">
      <div class="cart-item-info">
        <div class="cart-item-title">${esc(item.product_title)}</div>
        <div class="cart-item-variant">${esc(item.variant_title !== 'Default Title' ? (item.variant_title || '') : '')}</div>
        <div class="cart-item-price">€${(item.final_line_price / 100).toFixed(2)}</div>
        <div class="cart-item-qty">
          <button class="cart-qty-btn" data-action="decrease" data-key="${esc(item.key)}" data-qty="${item.quantity - 1}">−</button>
          <span>${item.quantity}</span>
          <button class="cart-qty-btn" data-action="increase" data-key="${esc(item.key)}" data-qty="${item.quantity + 1}">+</button>
        </div>
      </div>
      <button class="cart-item-remove" data-key="${esc(item.key)}" aria-label="Remove">✕</button>
    </div>
  `).join('');

  if (subtotal) subtotal.textContent = '€' + (cart.total_price / 100).toFixed(2);

  // Qty + remove buttons
  container.querySelectorAll('.cart-qty-btn').forEach(btn => {
    btn.addEventListener('click', () => updateCartItem(btn.dataset.key, parseInt(btn.dataset.qty, 10)));
  });
  container.querySelectorAll('.cart-item-remove').forEach(btn => {
    btn.addEventListener('click', () => updateCartItem(btn.dataset.key, 0));
  });
}

async function updateCartItem(key, quantity) {
  try {
    await fetch('/cart/change.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: key, quantity })
    });
    await refreshCart();
  } catch(e) { console.error('updateCartItem:', e); }
}

function openCartDrawer() {
  document.getElementById('cart-drawer')?.classList.add('open');
  document.getElementById('cart-drawer-overlay')?.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeCartDrawer() {
  document.getElementById('cart-drawer')?.classList.remove('open');
  document.getElementById('cart-drawer-overlay')?.classList.remove('open');
  document.body.style.overflow = '';
}

function setupCart() {
  document.getElementById('cart-drawer-close')?.addEventListener('click', closeCartDrawer);
  document.getElementById('cart-drawer-overlay')?.addEventListener('click', closeCartDrawer);

  // All cart icon buttons (desktop + mobile)
  document.querySelectorAll('#cart-icon-btn, [data-cart-open]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await refreshCart();
      openCartDrawer();
    });
  });

  // Modal CTA buttons
  const addBtn = document.getElementById('modal-add-cart');
  const buyBtn = document.getElementById('modal-buy-now');
  if (addBtn) {
    addBtn.addEventListener('click', e => {
      e.preventDefault();
      addToCart(_activeVariantId);
    });
  }
  if (buyBtn) {
    buyBtn.addEventListener('click', e => {
      e.preventDefault();
      buyNow(_activeVariantId);
    });
  }

  // Load initial cart count
  refreshCart();
}

// Legacy alias kept so buildLensSelector & populateModal still compile
function setCtaUrls(variantUrl) { setCtaVariant(variantUrl); }

function populateModal(p) {
  _imgs = (p.images || []).filter(Boolean);

  // Title + badges
  document.getElementById('modal-title').innerHTML =
    esc(p.title) + (!p.available ? ' <span class="oos-badge">(Out of Stock)</span>' : '');
  const badgesEl = document.getElementById('modal-badges');
  badgesEl.innerHTML = '';
  if (p.isFeatured)   { const b = document.createElement('span'); b.className='badge badge-featured'; b.textContent='New'; badgesEl.appendChild(b); }
  if (p.isBestSeller) { const b = document.createElement('span'); b.className='badge badge-bestseller'; b.textContent='Best Seller'; badgesEl.appendChild(b); }

  // Price: show range if switchable
  const priceEl = document.getElementById('modal-price');
  if (p.isSwitchable && p.priceMin !== p.priceMax && p.priceMin > 0) {
    priceEl.textContent = `€${p.priceMin.toFixed(2)} – €${p.priceMax.toFixed(2)}`;
  } else {
    priceEl.textContent = '€' + Number(p.price).toFixed(2);
  }

  // Meta — data-stock attr lets buildLensSelector update the badge per variant
  document.getElementById('modal-meta').innerHTML = `
    <div class="info-row"><span class="lbl">Type</span><span class="val">${esc(p.productType||'—')}</span></div>
    <div class="info-row"><span class="lbl">Age</span><span class="val">${esc(p.age||'—')}</span></div>
    <div class="info-row"><span class="lbl">Shape</span><span class="val">${esc(p.shape === 'D-Frame' ? '#D' : p.shape||'—')}</span></div>
    <div class="info-row">
      <span class="lbl">Stock</span>
      <span class="val" data-stock style="color:${p.available?'#000':'#aaa'}">${p.available?'In Stock':'Out of Stock'}</span>
    </div>`;

  buildColorSelector(p);
  buildLensSelector(p);  // may override CTA button hrefs for switchable products
  buildTabs(p);
  buildRecommendations(p);

  // Default CTA: first available variant
  if (!p.isSwitchable) {
    const firstVariant = p.variants?.find(v => v.available !== false) || p.variants?.[0];
    // Prefer direct numeric Shopify variant ID over URL parsing
    _activeVariantId = firstVariant?.id ? parseInt(firstVariant.id, 10) : null;
    setCtaUrls(firstVariant?.variant_url || p.url || '#');
  }
  buildCarousel(_imgs);
  if (_imgs.length) setMainImage(0);
}

// Real swatch images from color_swatches data — no more COLOR_MAP hex
function buildColorSelector(activeP) {
  const cs = document.getElementById('color-selector');
  cs.innerHTML = '';
  const siblings = colorSiblings[activeP._base] || [activeP];

  for (const sib of siblings) {
    const wrap = document.createElement('div');
    wrap.className = 'swatch-wrap' +
      (sib.id === activeP.id ? ' active' : '') +
      (!sib.available ? ' oos' : '');

    const swatchUrl = sib.color ? swatchImageMap[sib.color.toLowerCase()] : null;
    if (swatchUrl) {
      wrap.style.backgroundImage    = `url(${swatchUrl})`;
      wrap.style.backgroundSize     = 'cover';
      wrap.style.backgroundPosition = 'center';
    } else {
      wrap.style.background = '#ccc';
    }

    wrap.title = (sib.color || '') + (!sib.available ? ' (Out of Stock)' : '');
    if (sib.id !== activeP.id) wrap.addEventListener('click', () => populateModal(sib));
    cs.appendChild(wrap);
  }
}

// Polarisation lens selector — uses v4.2 variant fields directly (no string hacks)
function buildLensSelector(activeP) {
  const sec = document.getElementById('lens-section');
  const ls  = document.getElementById('lens-selector');
  ls.innerHTML = '';

  const status = activeP.polStatus;

  if (status === 'unknown' || !status) { sec.style.display = 'none'; return; }

  sec.style.display = 'block';

  if (status === 'polarised_only') {
    const pill = document.createElement('button');
    pill.className = 'lens-pill active'; pill.textContent = 'Polarised'; pill.disabled = true;
    ls.appendChild(pill);
    return;
  }

  if (status === 'non_polarised_only') {
    const pill = document.createElement('button');
    pill.className = 'lens-pill active'; pill.textContent = 'Non-Polarised'; pill.disabled = true;
    ls.appendChild(pill);
    return;
  }

  if (status === 'switchable') {
    // Index variants by is_polarised boolean (v4.2) — no option3 string parsing needed
    const lensMap = {}; // { 'Polarised': variant, 'Non-Polarised': variant }
    for (const v of activeP.variants) {
      const key = v.is_polarised ? 'Polarised' : 'Non-Polarised';
      if (!lensMap[key]) lensMap[key] = v;
    }

    const pills = [];

    // Updates price, store URL and stock badge for the selected lens variant
    const updateSelection = (key) => {
      const v = lensMap[key];
      if (!v) return;
      // Price
      document.getElementById('modal-price').textContent = '€' + Number(v.price).toFixed(2);
      // Update active variant for cart API
      if (v.id) _activeVariantId = parseInt(v.id, 10);
      setCtaUrls(v.variant_url || activeP.url);
      // Per-variant stock badge
      const stockEl = document.querySelector('#modal-meta .val[data-stock]');
      if (stockEl) {
        stockEl.textContent = v.available ? 'In Stock' : 'Out of Stock';
        stockEl.style.color = v.available ? '#000' : '#aaa';
      }
    };

    ['Polarised', 'Non-Polarised'].forEach((lbl, idx) => {
      const v     = lensMap[lbl];
      const avail = v?.available !== false;
      const pill  = document.createElement('button');
      pill.className = 'lens-pill' + (idx === 0 ? ' active' : '') + (!avail ? ' unavail' : '');
      pill.textContent = lbl + (!avail ? ' (OOS)' : '');
      if (v?.price) pill.title = '€' + Number(v.price).toFixed(2);

      if (!avail) {
        pill.disabled = true;
      } else {
        pill.addEventListener('click', () => {
          pills.forEach(p => p.classList.remove('active'));
          pill.classList.add('active');
          updateSelection(lbl);
        });
      }
      ls.appendChild(pill);
      pills.push(pill);
    });

    // Init: prefer Polarised if available, otherwise Non-Polarised
    const initKey = lensMap['Polarised']?.available !== false ? 'Polarised' : 'Non-Polarised';
    pills.forEach(p => p.classList.toggle('active', p.textContent.startsWith(initKey)));
    updateSelection(initKey);
    return;
  }
}

// ── Tab content renderers ─────────────────────────────────────────────

// Safe inline tags to preserve when copying content from Shopify HTML
const SAFE_INLINE = new Set(['A','B','STRONG','EM','I','BR','SPAN']);

// Copy safe inline children (text + <a>, <b>…) from src node into dst element.
function sanitizeInline(src, dst) {
  src.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      dst.appendChild(document.createTextNode(node.textContent));
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'A') {
        const a = document.createElement('a');
        let href = node.getAttribute('href') || '#';
        if (href.startsWith('/')) href = 'https://olivioandco.eu' + href;
        a.href = href; a.target = '_blank'; a.rel = 'noopener';
        a.style.cssText = 'color:#000;font-weight:700;text-decoration:underline';
        sanitizeInline(node, a);
        dst.appendChild(a);
      } else if (SAFE_INLINE.has(node.tagName)) {
        const el = document.createElement(
          node.tagName === 'STRONG' ? 'b' : node.tagName.toLowerCase()
        );
        sanitizeInline(node, el);
        dst.appendChild(el);
      } else {
        sanitizeInline(node, dst);
      }
    }
  });
  if (!dst.hasChildNodes()) dst.textContent = src.textContent.trim();
}

// Parse Shopify content_html into structured <p> + <ul> elements.
function renderFromHtml(html, container) {
  if (!html || !html.trim()) return false;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  let produced = 0;

  const walk = (parent) => {
    parent.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.trim();
        if (t) { const p = document.createElement('p'); p.textContent = t; container.appendChild(p); produced++; }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName;

      if (tag === 'UL' || tag === 'OL') {
        const ul = document.createElement('ul');
        node.querySelectorAll(':scope > li').forEach(li => {
          const liEl = document.createElement('li');
          sanitizeInline(li, liEl);
          if (liEl.textContent.trim()) ul.appendChild(liEl);
        });
        if (ul.children.length) { container.appendChild(ul); produced++; }

      } else if (tag === 'LI') {
        const ul = document.createElement('ul');
        const liEl = document.createElement('li');
        sanitizeInline(node, liEl);
        if (liEl.textContent.trim()) { ul.appendChild(liEl); container.appendChild(ul); produced++; }

      } else if (tag === 'P' || tag === 'DIV' || tag === 'SECTION') {
        if (node.querySelector('ul,ol,li,p')) { walk(node); }
        else {
          const t = node.textContent.trim();
          if (t) {
            const p = document.createElement('p');
            sanitizeInline(node, p);
            if (p.textContent.trim()) { container.appendChild(p); produced++; }
          }
        }
      } else if (/^H[1-6]$/.test(tag)) {
        const t = node.textContent.trim();
        if (t) {
          const p = document.createElement('p');
          p.style.fontWeight = '700';
          p.textContent = t;
          container.appendChild(p); produced++;
        }
      } else if (tag === 'BR' || tag === 'HR') {
        // skip
      } else {
        if (node.children.length) walk(node);
        else { const t = node.textContent.trim(); if (t) { const p = document.createElement('p'); p.textContent = t; container.appendChild(p); produced++; } }
      }
    });
  };

  walk(tmp);
  return produced > 0;
}

// Plain-text paragraph renderer (fallback when content_html is absent).
function renderParagraphs(text, container) {
  if (!text.trim()) return;
  let blocks = text.split(/\r?\n\r?\n+/).map(s => s.trim()).filter(Boolean);
  if (blocks.length <= 1 && text.includes('\n')) {
    blocks = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (blocks.length > 1) {
      const p = document.createElement('p'); p.textContent = blocks[0]; container.appendChild(p);
      const ul = document.createElement('ul');
      blocks.slice(1).forEach(line => { const li = document.createElement('li'); li.textContent = line; ul.appendChild(li); });
      if (ul.children.length) container.appendChild(ul);
      return;
    }
  }
  blocks.forEach((b, idx) => {
    const lines = b.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length > 1 && idx > 0) {
      const ul = document.createElement('ul');
      lines.forEach(l => { const li = document.createElement('li'); li.textContent = l; ul.appendChild(li); });
      container.appendChild(ul);
    } else {
      const p = document.createElement('p'); p.textContent = b; container.appendChild(p);
    }
  });
}

// Shipping tab: bullet list; for lines with "return/refund", only the word "link" is a hyperlink
function renderShipping(text, container) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return;
  const ul = document.createElement('ul');
  for (const line of lines) {
    const li = document.createElement('li');
    const hasReturnRef = /return|refund/i.test(line);
    const linkIdx      = hasReturnRef ? line.search(/\blink\b/i) : -1;
    if (linkIdx >= 0) {
      li.appendChild(document.createTextNode(line.slice(0, linkIdx)));
      const a = document.createElement('a');
      a.href = 'https://olivioandco.eu/pages/return-refund';
      a.target = '_blank'; a.rel = 'noopener';
      a.style.cssText = 'color:#000;font-weight:700;text-decoration:underline';
      a.textContent = line.slice(linkIdx, linkIdx + 4); // "link"
      li.appendChild(a);
      li.appendChild(document.createTextNode(line.slice(linkIdx + 4)));
    } else {
      li.textContent = line;
    }
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

// Auto-fit tab buttons to bar width
function fitTabBar() {
  const bar  = document.getElementById('tab-bar');
  const btns = [...bar.querySelectorAll('.tab-btn')];
  if (!btns.length) return;

  btns.forEach(b => { b.style.fontSize = ''; b.style.letterSpacing = ''; });

  const barW    = bar.clientWidth;
  const totalW  = btns.reduce((s, b) => s + b.scrollWidth, 0);

  if (totalW > barW + 2) {
    const ratio = barW / totalW;
    const fs    = Math.max(7.5, parseFloat((10 * ratio).toFixed(1)));
    const ls    = parseFloat((.07 * ratio).toFixed(3));
    btns.forEach(b => { b.style.fontSize = fs + 'px'; b.style.letterSpacing = ls + 'em'; });
  }
}

// 4-tab structure — v4.2 tabs are fully populated; size_guide has images[] array
function buildTabs(p) {
  const tabBar     = document.getElementById('tab-bar');
  const tabContent = document.getElementById('tab-content');
  tabBar.innerHTML = ''; tabContent.innerHTML = '';

  const stripHtml = html => (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  const descHtml = p.tabs?.description?.content_html || '';
  const descText = p.descFallback || '';
  const matHtml  = p.tabs?.materials?.content_html || '';
  const matText  = (p.tabs?.materials?.content_text || stripHtml(matHtml)).trim();
  const shipHtml = p.tabs?.shipping_and_customs?.content_html || '';
  const shipText = (p.tabs?.shipping_and_customs?.content_text || stripHtml(shipHtml)).trim();

  const sg       = p.tabs?.size_guide;
  const sgImages = Array.isArray(sg?.images) ? sg.images : [];
  const sgText   = stripHtml(sg?.content_text || sg?.content_html || '');
  const hasDim   = sgImages.length > 0 || sgText.length > 5;

  const TAB_DATA = [
    { label: 'Description',      text: descText, html: descHtml, images: null,     type: 'para' },
    ...(matText.length > 5  ? [{ label: 'Materials',          text: matText,  html: matHtml,  images: null,     type: 'para' }] : []),
    ...(hasDim              ? [{ label: 'Dimensions',          text: sgText,   html: '',       images: sgImages, type: 'dim'  }] : []),
    ...(shipText.length > 5 ? [{ label: 'Shipping & Customs', text: shipText, html: shipHtml, images: null,     type: 'ship' }] : []),
  ];

  if (!descText && !descHtml) { document.getElementById('tabs-section').style.display = 'none'; return; }
  document.getElementById('tabs-section').style.display = '';

  TAB_DATA.forEach(({ label, text, html, images, type }, i) => {

    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (i === 0 ? ' active' : '');
    btn.textContent = label;
    tabBar.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'tab-panel' + (i === 0 ? ' active' : '');

    if (type === 'dim' && images && images.length > 0) {
      images.forEach(({ src, alt }) => {
        const img = document.createElement('img');
        img.src = src; img.alt = alt || '';
        img.style.cssText = 'max-width:100%;height:auto;display:block;margin-bottom:8px;border-radius:3px';
        img.loading = 'lazy';
        panel.appendChild(img);
      });
      if (text) renderParagraphs(text, panel);
    } else if (type === 'ship') {
      if (!renderFromHtml(html, panel)) {
        renderShipping(text, panel);
      } else {
        panel.querySelectorAll('li').forEach(li => {
          if (/return|refund/i.test(li.textContent) && !li.querySelector('a')) {
            const t = li.textContent;
            const linkIdx = t.search(/\blink\b/i);
            if (linkIdx >= 0) {
              li.innerHTML = '';
              li.appendChild(document.createTextNode(t.slice(0, linkIdx)));
              const a = document.createElement('a');
              a.href = 'https://olivioandco.eu/pages/return-refund';
              a.target = '_blank'; a.rel = 'noopener';
              a.style.cssText = 'color:#000;font-weight:700;text-decoration:underline';
              a.textContent = t.slice(linkIdx, linkIdx + 4);
              li.appendChild(a);
              li.appendChild(document.createTextNode(t.slice(linkIdx + 4)));
            }
          }
        });
      }
    } else {
      if (!renderFromHtml(html, panel)) {
        renderParagraphs(text, panel);
      }
    }
    tabContent.appendChild(panel);

    btn.addEventListener('click', () => {
      tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      tabContent.querySelectorAll('.tab-panel').forEach(pn => pn.classList.remove('active'));
      btn.classList.add('active');
      panel.classList.add('active');
    });
  });

  requestAnimationFrame(fitTabBar);
}

// "You may also like" recommendations
function buildRecommendations(p) {
  const sec    = document.getElementById('reco-section');
  const scroll = document.getElementById('reco-scroll');
  scroll.innerHTML = '';

  const recos = p.recos || [];
  if (recos.length === 0) { sec.style.display = 'none'; return; }
  sec.style.display = '';

  for (const r of recos) {
    const card = document.createElement('div');
    card.className = 'reco-card';

    const imgWrap = document.createElement('div'); imgWrap.className = 'reco-img';
    const img = document.createElement('img'); img.src = r.image || ''; img.alt = '';
    imgWrap.appendChild(img);

    const name  = document.createElement('div'); name.className = 'reco-name'; name.textContent = r.title || '';
    const price = document.createElement('div'); price.className = 'reco-price';
    price.textContent = r.price != null ? '€' + Number(r.price).toFixed(2) : '';

    card.appendChild(imgWrap); card.appendChild(name); card.appendChild(price);

    // Click: open in modal if found in dataset, else visit URL
    card.addEventListener('click', () => {
      const found = r.id && productById[r.id];
      if (found) populateModal(found);
      else if (r.url) window.open(r.url, '_blank');
    });
    scroll.appendChild(card);
  }
}

function buildCarousel(images) {
  const car = document.getElementById('modal-carousel'); car.innerHTML = '';
  images.forEach((src, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'c-thumb' + (i===0?' active':'');
    const img = document.createElement('img');
    img.src = shopifyImg(src, 120); img.alt = ''; img.loading = 'lazy';
    thumb.appendChild(img);
    thumb.addEventListener('click', () => setMainImage(i));
    car.appendChild(thumb);
  });
}

function setMainImage(idx) {
  const main = document.getElementById('modal-main-img');
  const isLast = idx === _imgs.length - 1 && _imgs.length > 1;
  main.className = isLast ? 'img-contain' : 'img-cover';
  main.src = shopifyImg(_imgs[idx], IMAGE_WIDTH);
  document.querySelectorAll('.c-thumb').forEach((t,i) => t.classList.toggle('active', i===idx));
}

/* ── Welcome Popup Logic ──────────────────────────── */
(function() {
  const overlay  = document.getElementById('welcome-overlay');
  const closeBtn = document.getElementById('welcome-close');
  const step1    = document.getElementById('wp-step1');
  const step2    = document.getElementById('wp-step2');
  const continueBtn = document.getElementById('wp-continue');
  const claimBtn = document.getElementById('wp-claim');
  const skipBtn  = document.getElementById('wp-skip');
  const emailEl  = document.getElementById('wp-email');

  function closePopup() {
    overlay.classList.remove('open');
    localStorage.setItem('oc_popup_seen', '1');
  }

  if (!localStorage.getItem('oc_popup_seen')) {
    setTimeout(() => overlay.classList.add('open'), 2000);
  }

  // Region selection
  document.querySelectorAll('.wp-region').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.wp-region').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  // Step 1 → Step 2
  continueBtn.addEventListener('click', () => {
    const sel = document.querySelector('.wp-region.selected');
    if (sel) localStorage.setItem('oc_region', sel.dataset.region);
    step1.classList.remove('active');
    step2.classList.add('active');
  });

  // Claim discount
  claimBtn.addEventListener('click', () => {
    if (emailEl.value.trim()) {
      localStorage.setItem('oc_email', emailEl.value.trim());
    }
    closePopup();
  });

  // Skip
  skipBtn.addEventListener('click', closePopup);

  // Close button
  closeBtn.addEventListener('click', closePopup);

  // Backdrop click
  overlay.addEventListener('click', e => { if (e.target === overlay) closePopup(); });
})();
