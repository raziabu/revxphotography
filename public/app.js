/* Shared front-end behaviour: lightbox, copy buttons, confirm dialogs, category filter, uploader. */
(() => {
  // ---------- lightbox ----------
  const lb = document.getElementById('lightbox');
  if (lb) {
    const stage = lb.querySelector('.lb-stage');
    const caption = lb.querySelector('.lb-caption');
    let items = [];
    let index = 0;

    const collect = () => Array.from(document.querySelectorAll('[data-lb]'));

    const render = () => {
      const el = items[index];
      if (!el) return;
      const type = el.dataset.type;
      const src = el.dataset.src;
      stage.innerHTML = '';
      let node;
      if (type === 'video') {
        node = document.createElement('video');
        node.src = src; node.controls = true; node.autoplay = true; node.playsInline = true;
        if (el.dataset.poster) node.poster = el.dataset.poster;
        node.setAttribute('controlsList', 'nodownload');
      } else if (type === 'embed') {
        node = document.createElement('iframe');
        node.src = src + (src.includes('?') ? '&' : '?') + 'autoplay=1';
        node.allow = 'autoplay; fullscreen; picture-in-picture';
        node.allowFullscreen = true;
      } else {
        node = document.createElement('img');
        node.src = src; node.alt = el.dataset.caption || '';
        node.draggable = false;
      }
      stage.appendChild(node);
      caption.innerHTML = '';
      const text = document.createElement('span');
      text.textContent = `${el.dataset.caption || ''}${items.length > 1 ? `  ·  ${index + 1} / ${items.length}` : ''}`;
      caption.appendChild(text);
      if (el.dataset.download) {
        const a = document.createElement('a');
        a.href = el.dataset.download; a.textContent = '⬇ Download';
        caption.appendChild(a);
      }
    };
    const open = (el) => {
      items = collect();
      index = Math.max(0, items.indexOf(el));
      lb.hidden = false;
      document.body.style.overflow = 'hidden';
      render();
    };
    const close = () => { lb.hidden = true; stage.innerHTML = ''; document.body.style.overflow = ''; };
    const step = (d) => { if (!items.length) return; index = (index + d + items.length) % items.length; render(); };

    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-lb]');
      if (el && !e.target.closest('a, button, form')) { e.preventDefault(); open(el); }
    });
    lb.querySelector('.lb-close').addEventListener('click', close);
    lb.querySelector('.lb-prev').addEventListener('click', () => step(-1));
    lb.querySelector('.lb-next').addEventListener('click', () => step(1));
    lb.addEventListener('click', (e) => { if (e.target === lb || e.target === stage) close(); });
    document.addEventListener('keydown', (e) => {
      if (lb.hidden) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    });
    // swipe
    let sx = 0;
    lb.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', (e) => { const dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1); });
  }

  // ---------- copy to clipboard ----------
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = btn.dataset.copy; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    const old = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = old; }, 1600);
  });

  // ---------- confirm dialogs ----------
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-confirm]');
    if (form && !confirm(form.dataset.confirm)) e.preventDefault();
  });

  // ---------- toggles ----------
  document.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.querySelector(btn.dataset.toggle);
      if (!target) return;
      target.hidden = !target.hidden;
      if (!target.hidden) target.querySelector('input')?.focus();
    });
  });

  // ---------- portfolio category filter ----------
  const filter = document.querySelector('[data-filter]');
  if (filter) {
    filter.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      filter.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
      const cat = chip.dataset.cat;
      document.querySelectorAll('.masonry .tile').forEach((t) => {
        t.style.display = !cat || t.dataset.cat === cat ? '' : 'none';
      });
    });
  }

  // ---------- uploader with progress ----------
  document.querySelectorAll('[data-uploader]').forEach((zone) => {
    const input = zone.querySelector('input[type=file]');
    const progress = zone.querySelector('.progress');
    const bar = zone.querySelector('.bar');
    const text = zone.querySelector('.progress-text');
    const url = zone.dataset.uploader;

    const uploadOne = (file, i, total) => new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('files', file, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        const pct = Math.round(((i + ev.loaded / ev.total) / total) * 100);
        bar.style.width = pct + '%';
        text.textContent = `Uploading ${i + 1} of ${total}: ${file.name} (${pct}%)`;
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let msg = `Upload failed (${xhr.status})`;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* ignore */ }
        reject(new Error(msg));
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(fd);
    });

    const run = async (files) => {
      if (!files.length) return;
      progress.hidden = false;
      bar.style.width = '0%';
      const list = Array.from(files);
      const errors = [];
      for (let i = 0; i < list.length; i++) {
        try { await uploadOne(list[i], i, list.length); }
        catch (err) { errors.push(`${list[i].name}: ${err.message}`); }
      }
      text.textContent = errors.length ? `Done with ${errors.length} error(s)` : 'Done! Refreshing…';
      if (errors.length) alert(errors.join('\n'));
      location.reload();
    };

    input.addEventListener('change', () => run(input.files));
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
    zone.addEventListener('drop', (e) => run(e.dataTransfer.files));
  });
})();

/* ===== v2: reveal-on-scroll, sticky nav, scroll-driven car hero ===== */
(() => {
  // reveal
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealEls = document.querySelectorAll('.reveal');
  if (reduce || !('IntersectionObserver' in window)) {
    revealEls.forEach((el) => el.classList.add('in'));
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    revealEls.forEach((el) => io.observe(el));
  }

  // nav background after scrolling
  const bar = document.querySelector('.topbar.public');
  if (bar) {
    const onScroll = () => bar.classList.toggle('scrolled', window.scrollY > 40);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // category filter now also handles album cards
  const filter = document.querySelector('[data-filter]');
  if (filter) {
    filter.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const cat = chip.dataset.cat;
      document.querySelectorAll('[data-filter-group] [data-cat]').forEach((t) => {
        t.style.display = !cat || t.dataset.cat === cat ? '' : 'none';
      });
    });
  }

  // scroll-driven car hero
  const hero = document.querySelector('[data-car-hero]');
  if (!hero) return;
  const canvas = hero.querySelector('.hero-canvas');
  const ctx = canvas.getContext('2d');
  const copies = { start: hero.querySelector('.hero-copy-start'), mid: hero.querySelector('.hero-copy-mid'), end: hero.querySelector('.hero-copy-end') };
  let frames = [];
  let meta = null;
  let current = -1;
  let fallback = null;

  const size = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    current = -1;
    draw();
  };

  const drawImage = (img) => {
    if (!img || !img.complete || !img.naturalWidth) return;
    const cw = canvas.width, ch = canvas.height;
    // landscape viewports: cover. Portrait (phones): fit the width so the whole car stays visible.
    const portrait = cw / ch < 1;
    const s = portrait ? (cw / img.naturalWidth) * 1.15 : Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const w = img.naturalWidth * s, h = img.naturalHeight * s;
    ctx.fillStyle = '#050506';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, (cw - w) / 2, portrait ? (ch - h) * 0.42 : (ch - h) / 2, w, h);
  };

  const progress = () => {
    const rect = hero.getBoundingClientRect();
    const total = hero.offsetHeight - window.innerHeight;
    return Math.min(1, Math.max(0, -rect.top / total));
  };

  const draw = () => {
    const p = progress();
    if (meta && frames.length) {
      const idx = Math.round(p * (meta.count - 1));
      if (idx !== current) {
        // use the wanted frame, or the nearest one that has finished loading
        let use = -1;
        for (let d = 0; d < meta.count && use < 0; d++) {
          for (const j of [idx - d, idx + d]) {
            const img = frames[j];
            if (img && img.complete && img.naturalWidth) { use = j; break; }
          }
        }
        if (use >= 0) { drawImage(frames[use]); current = use === idx ? idx : -1; }
        else if (fallback) drawImage(fallback);
      }
    } else if (fallback) {
      drawImage(fallback);
    }
    copies.start.classList.toggle('on', p < 0.22);
    copies.mid.classList.toggle('on', p >= 0.38 && p < 0.66);
    copies.end.classList.toggle('on', p >= 0.8);
    hero.classList.toggle('done', p > 0.1);
  };

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { draw(); ticking = false; });
  };

  fetch('/car/frames.json').then((r) => r.json()).then((m) => {
    meta = m;
    // first frame immediately, rest in order
    const load = (i) => {
      const img = new Image();
      img.decoding = 'async';
      img.src = `/car/${m.pattern.replace('{i}', String(i + 1).padStart(3, '0'))}`;
      frames[i] = img;
      return img;
    };
    const first = load(0);
    first.onload = () => { fallback = first; draw(); };
    for (let i = 1; i < m.count; i++) load(i).onload = () => { current = -1; draw(); };
  }).catch(() => { /* no frames: hero stays static */ });

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', size);
  size();
})();

/* ===== v4: "build your own" package calculator (base package + add-ons) ===== */
(() => {
  document.querySelectorAll('[data-calc]').forEach((box) => {
    let c;
    try { c = JSON.parse(box.dataset.calc); } catch { return; }
    const bases = box.querySelectorAll('[data-calc-base]');
    const photosEl = box.querySelector('[data-calc-extra-photos]');
    const videosEl = box.querySelector('[data-calc-extra-videos]');
    const total = box.querySelector('[data-calc-total]');
    const breakdown = box.querySelector('[data-calc-breakdown]');
    const link = box.querySelector('[data-calc-link]');
    const customFields = box.querySelector('.custom-fields');
    const customRadio = box.querySelector('input[name=package][value=custom]');
    if (!bases.length || !photosEl || !videosEl || !total) return;

    const fmt = (cents) => {
      try { return new Intl.NumberFormat('en', { style: 'currency', currency: c.currency || 'ILS', maximumFractionDigits: 0 }).format(cents / 100); }
      catch { return `${Math.round(cents / 100)} ${c.currency || ''}`; }
    };
    const clamp = (el) => { el.value = Math.min(Number(el.max), Math.max(0, parseInt(el.value, 10) || 0)); return Number(el.value); };

    const update = () => {
      const slug = [...bases].find((b) => b.checked)?.value;
      const base = c.packages.find((p) => p.slug === slug);
      bases.forEach((b) => b.closest('.chip')?.classList.toggle('active', b.checked));
      const photos = clamp(photosEl), videos = clamp(videosEl);
      if (!base) { total.textContent = '—'; return; }
      const sum = base.price_cents + photos * c.extraPhotoCents + videos * c.extraVideoCents;
      total.textContent = fmt(sum);
      const parts = [`${base.name} ${fmt(base.price_cents)}`];
      if (photos) parts.push(`${photos} extra photo${photos > 1 ? 's' : ''} ${fmt(photos * c.extraPhotoCents)}`);
      if (videos) parts.push(`${videos} extra video${videos > 1 ? 's' : ''} ${fmt(videos * c.extraVideoCents)}`);
      if (breakdown) breakdown.textContent = parts.join('  +  ');
      if (link) link.href = `/book?package=custom&base=${encodeURIComponent(slug)}&photos=${photos}&videos=${videos}`;
    };

    const selectCustom = () => {
      if (customRadio && !customRadio.checked) customRadio.checked = true;
      if (customFields) customFields.hidden = false;
    };

    box.querySelectorAll('[data-step]').forEach((btn) => btn.addEventListener('click', () => {
      const el = btn.dataset.for === 'photos' ? photosEl : videosEl;
      el.value = (parseInt(el.value, 10) || 0) + Number(btn.dataset.step);
      selectCustom(); update();
    }));
    [photosEl, videosEl].forEach((el) => el.addEventListener('input', () => { selectCustom(); update(); }));
    bases.forEach((b) => b.addEventListener('change', () => { selectCustom(); update(); }));
    box.querySelectorAll('input[name=package]').forEach((r) => r.addEventListener('change', () => {
      if (customFields) customFields.hidden = !customRadio?.checked;
    }));
    update();
  });
})();

/* ===== v5: discourage right-click saving on public (non-downloadable) images ===== */
(() => {
  document.addEventListener('contextmenu', (e) => {
    const protectedPage = Boolean(document.querySelector('[data-protect]'));
    if (e.target.closest('[data-protect] img, [data-protect] video') || (protectedPage && e.target.closest('.lb-stage img'))) e.preventDefault();
  });
  document.addEventListener('dragstart', (e) => {
    if (e.target.closest('[data-protect] img')) e.preventDefault();
  });
})();
