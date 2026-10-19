import { normalize, getLabel } from './iiif.js';
import { parseQuery, buildUrl } from './query.js';
import { getInboxes, saveInboxes, getOptIn, setOptIn, queryInbox } from './ldn.js';
import { escapeHtml, sanitizeHtml, parseXYWH, cropImage } from './utils.js';

const UNIVERSE_URL = 'https://ryanfb.github.io/iiif-universe/iiif-universe.json';
const DEFAULT_INBOX = 'https://inbox.rerum.io/messages';

async function fetchJSON(uri) {
  if (/^http:\/\//i.test(uri)) {
    throw new Error('HTTP sources are not supported; use an HTTPS URI.');
  }
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`Failed to load ${uri}: ${res.status} ${res.statusText}`);
  return res.json();
}

class ReadViewer extends HTMLElement {
  constructor() {
    super();
    this.state = {
      resource: null,
      canvasIndex: 0,
      view: 'image',
      block: true,
      language: 'en',
      loading: false,
      error: null,
      universe: null,
      collection: null,
      ldn: { results: [], included: new Set(), checked: false },
      shareOpen: false,
      settingsOpen: false,
      region: null,
      focusAnnotation: null,
    };
    this.onPopState = () => this.init();
  }

  connectedCallback() {
    this.addEventListener('click', this.onClick);
    this.addEventListener('change', this.onChange);
    this.addEventListener('mouseover', this.onMouseOver);
    this.addEventListener('mouseleave', this.onMouseLeave);
    window.addEventListener('popstate', this.onPopState);
    this.init();
  }

  disconnectedCallback() {
    window.removeEventListener('popstate', this.onPopState);
  }

  async init() {
    const q = parseQuery();
    if (q.iiifContent) {
      await this.loadResource(q.iiifContent, q);
    } else if (q.manifest) {
      await this.loadResource(q.manifest, q);
    } else {
      this.render();
      this.loadUniverse();
    }
  }

  onClick(event) {
    const el = event.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if ((action === 'close-share' || action === 'close-settings') && event.target !== el) return;
    switch (action) {
      case 'load-input': this.loadFromInput(); break;
      case 'prev-canvas': this.moveCanvas(-1); break;
      case 'next-canvas': this.moveCanvas(1); break;
      case 'toggle-view': this.state.view = this.state.view === 'image' ? 'annotations' : 'image'; this.refresh(); break;
      case 'toggle-block': this.state.block = !this.state.block; this.refresh(); break;
      case 'open-share': this.state.shareOpen = true; this.render(); break;
      case 'close-share': this.state.shareOpen = false; this.render(); break;
      case 'open-settings': this.state.settingsOpen = true; this.render(); break;
      case 'close-settings': this.state.settingsOpen = false; this.render(); break;
      case 'add-inbox': this.addInbox(); break;
      case 'remove-inbox': this.removeInbox(el.dataset.inbox); break;
      case 'include-ldn': this.includeLdn(el.dataset.anno); break;
      case 'copy-bounded':
      case 'copy-full':
      case 'copy-deep': this.copyLink(el.dataset.url); break;
      case 'download-crop': this.downloadCrop(); break;
      case 'reload-universe': this.loadUniverse(); break;
      case 'clear': this.clear(); break;
      case 'select-annotation': this.selectAnnotation(el.dataset.anno || null); break;
    }
  }

  onChange(event) {
    const el = event.target;
    if (el.matches('[data-action="canvas-select"]')) {
      this.selectCanvas(el.value);
    } else if (el.matches('[data-action="collection-select"]')) {
      this.loadCollection(el.value);
    } else if (el.matches('[data-action="manifest-select"]')) {
      if (el.value) this.loadResource(el.value, {});
    } else if (el.matches('[data-action="set-language"]')) {
      this.state.language = el.value;
      this.render();
    } else if (el.matches('[data-action="ldn-optin"]')) {
      setOptIn(el.checked);
      if (el.checked) this.checkLdn();
    }
  }

  onMouseOver(event) {
    const el = event.target.closest('[data-anno]');
    if (!el) {
      this.hideBacksplash();
      return;
    }
    const canvas = (this.state.resource?.canvases || [])[this.state.canvasIndex];
    if (!canvas) return;
    const anno = (canvas.annotations || []).find((a) => a.id === el.dataset.anno);
    if (!anno || !anno.selector) return;
    const xywh = parseXYWH(anno.selector);
    if (!xywh) return;
    const image = (canvas.images || [])[0];
    if (!image) return;
    const backsplash = this.querySelector('#backsplash');
    if (!backsplash) return;
    const [x, y, w, h] = xywh;
    const iw = window.innerWidth * canvas.width / w;
    const ratio = iw / canvas.width;
    backsplash.src = image.id;
    backsplash.style.display = 'block';
    backsplash.style.left = (-x * ratio) + 'px';
    backsplash.style.top = (-y * ratio) + 'px';
    backsplash.style.width = iw + 'px';
    backsplash.style.opacity = '0.6';
  }

  onMouseLeave() {
    this.hideBacksplash();
  }

  hideBacksplash() {
    const backsplash = this.querySelector('#backsplash');
    if (backsplash) {
      backsplash.style.display = 'none';
      backsplash.style.opacity = '0';
    }
  }

  loadFromInput() {
    const input = this.querySelector('#resource-input');
    const uri = input && input.value.trim();
    if (uri) this.loadResource(uri, {});
  }

  async loadResource(uri, query = {}) {
    this.state.loading = true;
    this.state.error = null;
    this.state.region = query.region || null;
    this.state.focusAnnotation = query.annotation || null;
    this.render();
    try {
      const data = await fetchJSON(uri);
      const resource = normalize(data);
      // Keep the requested URI as the canonical id: the resource's declared
      // @id may not be fetchable (e.g. T-PEN's /manifest/4080/manifest.json
      // returns an empty body), and shareable URLs must point at a working URI.
      this.state.resource = { ...resource, id: uri };
      this.state.canvasIndex = 0;
      if (resource.type === 'Collection') {
        this.updateUrl();
        this.render();
        return;
      }
      if (resource.type === 'Annotation' || resource.type === 'AnnotationPage' || resource.type === 'AnnotationCollection') {
        await this.resolveAnnotationResource(resource);
      } else {
        await this.loadExternalAnnotations(resource);
      }
      if (query.canvas) this.selectCanvas(query.canvas, { silent: true });
      this.refresh();
      this.focusAnnotationElement();
      this.checkLdn();
    } catch (err) {
      this.state.error = err.message || String(err);
    } finally {
      this.state.loading = false;
    }
    this.render();
  }

  async resolveAnnotationResource(resource) {
    const annos = (resource.annotations || []).filter((a) => !a.external);
    const external = (resource.annotations || []).filter((a) => a.external);
    const byTarget = new Map();
    for (const a of annos) {
      if (!a.target) continue;
      const key = a.target.split('#')[0];
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key).push(a);
    }
    const canvases = [];
    for (const [uri, list] of byTarget) {
      try {
        const data = await fetchJSON(uri);
        const res = normalize(data);
        if (res.type === 'Canvas') {
          const c = res.canvases[0];
          c.annotations.push(...list);
          canvases.push(c);
        } else if (res.type === 'Manifest') {
          const c = res.canvases.find((cv) => cv.id === uri) || res.canvases[0];
          if (c) {
            c.annotations.push(...list);
            canvases.push(c);
          }
        }
      } catch {
        /* skip unresolvable targets */
      }
    }
    for (const ext of external) {
      try {
        const data = await fetchJSON(ext.external);
        const res = normalize(data);
        for (const a of (res.annotations || [])) {
          if (!a.target) continue;
          const key = a.target.split('#')[0];
          const c = canvases.find((cv) => cv.id === key);
          if (c) c.annotations.push(a);
        }
      } catch {
        /* skip */
      }
    }
    this.state.resource = { ...resource, canvases };
  }

  async loadExternalAnnotations(resource) {
    for (const canvas of resource.canvases || []) {
      for (const uri of canvas.externalAnnotations || []) {
        try {
          const data = await fetchJSON(uri);
          const page = normalize(data);
          for (const a of (page.annotations || [])) {
            if (!a.external) canvas.annotations.push(a);
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  selectCanvas(value, opts = {}) {
    const canvases = this.state.resource?.canvases || [];
    let index = -1;
    if (/^\d+$/.test(value)) index = parseInt(value, 10);
    else index = canvases.findIndex((c) => c.id === value);
    if (index > -1) this.state.canvasIndex = index;
    if (!opts.silent) {
      this.state.region = null;
      this.state.focusAnnotation = null;
      this.refresh();
      this.checkLdn();
    }
  }

  moveCanvas(delta) {
    const canvases = this.state.resource?.canvases || [];
    const next = this.state.canvasIndex + delta;
    if (next < 0 || next >= canvases.length) return;
    this.state.canvasIndex = next;
    this.state.region = null;
    this.state.focusAnnotation = null;
    this.refresh();
    this.checkLdn();
  }

  refresh() {
    this.updateUrl();
    this.render();
    this.focusAnnotationElement();
  }

  selectAnnotation(id) {
    this.state.focusAnnotation = id || null;
    this.updateUrl();
    for (const el of this.querySelectorAll('[data-anno]')) {
      el.classList.toggle('focused', !!id && el.dataset.anno === id);
    }
    this.focusAnnotationElement();
  }

  updateUrl() {
    const r = this.state.resource;
    if (!r) return;
    const params = { 'iiif-content': r.id, manifest: null };
    const canvas = (r.canvases || [])[this.state.canvasIndex];
    if (canvas && canvas.id) params.canvas = canvas.id;
    if (this.state.region) params.region = this.state.region;
    if (this.state.focusAnnotation) params.annotation = this.state.focusAnnotation;
    history.pushState({}, '', buildUrl(window.location.href, params));
  }

  focusAnnotationElement() {
    if (!this.state.focusAnnotation) return;
    const el = this.querySelector(`[data-anno="${CSS.escape(this.state.focusAnnotation)}"]`);
    if (el) this.smoothScrollTo(el);
  }

  smoothScrollTo(el) {
    const scroller = this.scrollContainer(el);
    const rect = el.getBoundingClientRect();
    const sRect = scroller.getBoundingClientRect();
    const viewport = scroller === document.scrollingElement ? window.innerHeight : sRect.height;
    const target = scroller.scrollTop + rect.top - sRect.top - viewport / 2 + rect.height / 2;
    const start = scroller.scrollTop;
    const delta = target - start;
    if (Math.abs(delta) < 1) return;
    if (this._scrollAnim) cancelAnimationFrame(this._scrollAnim);
    const duration = Math.min(500, Math.max(200, Math.abs(delta) * 0.4));
    const t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      scroller.scrollTop = start + delta * ease(p);
      if (p < 1) this._scrollAnim = requestAnimationFrame(step);
      else this._scrollAnim = null;
    };
    this._scrollAnim = requestAnimationFrame(step);
  }

  scrollContainer(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  async checkLdn() {
    if (!getOptIn()) return;
    const r = this.state.resource;
    if (!r) return;
    const canvas = (r.canvases || [])[this.state.canvasIndex];
    const targets = [r.id];
    if (canvas && canvas.id) targets.push(canvas.id);
    const results = [];
    for (const inbox of getInboxes()) {
      for (const target of targets) {
        try {
          const messages = await queryInbox(inbox, target);
          for (const m of messages) {
            const res = normalize(m);
            if (res.type === 'Annotation' || res.type === 'AnnotationPage' || res.type === 'AnnotationCollection') {
              for (const a of (res.annotations || [])) {
                if (!a.external) results.push({ ...a, source: 'ldn' });
              }
            }
          }
        } catch {
          /* skip unreachable inboxes */
        }
      }
    }
    this.state.ldn.results = results;
    this.state.ldn.checked = true;
    this.render();
  }

  includeLdn(annoId) {
    const canvas = (this.state.resource?.canvases || [])[this.state.canvasIndex];
    const anno = this.state.ldn.results.find((a) => a.id === annoId);
    if (!canvas || !anno) return;
    if (!canvas.annotations.some((a) => a.id === annoId)) {
      canvas.annotations.push({ ...anno, source: 'ldn' });
    }
    this.state.ldn.included.add(annoId);
    this.refresh();
  }

  getFocusedAnnotation() {
    const canvas = (this.state.resource?.canvases || [])[this.state.canvasIndex];
    if (!canvas) return null;
    return (canvas.annotations || []).find((a) => a.id === this.state.focusAnnotation) || null;
  }

  async copyLink(url) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  async downloadCrop() {
    const canvas = (this.state.resource?.canvases || [])[this.state.canvasIndex];
    const anno = this.getFocusedAnnotation();
    if (!canvas || !anno || !anno.selector) return;
    const image = (canvas.images || [])[0];
    if (!image) return;
    const xywh = parseXYWH(anno.selector);
    if (!xywh) return;
    const result = await cropImage(image.id, canvas.width, canvas.height, xywh);
    if (!result.dataUrl) return;
    const a = document.createElement('a');
    a.href = result.dataUrl;
    a.download = 'annotation.png';
    a.click();
  }

  addInbox() {
    const input = this.querySelector('#new-inbox-input');
    const uri = input && input.value.trim();
    if (!uri) return;
    const inboxes = getInboxes();
    if (!inboxes.includes(uri)) {
      inboxes.push(uri);
      saveInboxes(inboxes);
    }
    this.render();
  }

  removeInbox(uri) {
    const inboxes = getInboxes().filter((i) => i !== uri);
    saveInboxes(inboxes.length ? inboxes : [DEFAULT_INBOX]);
    this.render();
  }

  async loadUniverse() {
    try {
      const res = await fetch(UNIVERSE_URL);
      const data = await res.json();
      this.state.universe = data;
      this.render();
    } catch {
      this.state.universe = null;
      this.render();
    }
  }

  async loadCollection(collectionID) {
    if (!collectionID) {
      this.state.collection = null;
      this.render();
      return;
    }
    try {
      const res = await fetch(collectionID);
      const data = await res.json();
      this.state.collection = data;
      this.render();
    } catch (err) {
      this.state.error = err.message || String(err);
      this.render();
    }
  }

  clear() {
    this.state.resource = null;
    this.state.error = null;
    this.state.region = null;
    this.state.focusAnnotation = null;
    this.state.ldn = { results: [], included: new Set(), checked: false };
    history.pushState({}, '', window.location.pathname);
    this.render();
  }

  getLanguages(r) {
    const d = r.descriptions;
    if (d && typeof d === 'object' && !Array.isArray(d)) return Object.keys(d);
    return [];
  }

  currentDescription(r) {
    const d = r.descriptions;
    if (d && typeof d === 'object' && !Array.isArray(d) && d[this.state.language] != null) {
      return getLabel({ label: d[this.state.language] });
    }
    return r.description;
  }

  render() {
    const s = this.state;
    if (s.loading) {
      this.innerHTML = '<div class="container"><p>Loading…</p></div>';
      return;
    }
    if (!s.resource) {
      this.innerHTML = this.landingTemplate();
      return;
    }
    if (s.resource.type === 'Collection') {
      this.innerHTML = this.collectionTemplate();
      return;
    }
    this.innerHTML = this.viewerTemplate();
    if (s.view === 'annotations' || s.region) this.hydrateCrops();
  }

  landingTemplate() {
    const s = this.state;
    const u = s.universe;
    return `<div class="container">
      <div class="row">
        <input type="url" id="resource-input" placeholder="Paste or type a URI for any Manifest" class="six columns">
        <button class="button" data-action="load-input">Load it</button>
      </div>
      ${u ? `<span>
        <button role="button" class="button" data-action="reload-universe" title="reload universe"><i class="fa fa-globe fa-rotate-90"></i></button>
        <select data-action="collection-select">
          <option value="">${escapeHtml(u.label || 'IIIF Universe')}</option>
          ${(u.collections || []).map((c) => `<option value="${escapeHtml(c['@id'] || c.id || '')}">${escapeHtml(c.label || c['@id'] || '')}</option>`).join('')}
        </select>
        ${s.collection && (s.collection.manifests || []).length ? `<select data-action="manifest-select">
          <option value="">${escapeHtml(s.collection.label || 'Select a Manifest')}</option>
          ${s.collection.manifests.map((m, i) => `<option value="${escapeHtml(m['@id'] || m.id || '')}">${escapeHtml(m.label || i)}</option>`).join('')}
        </select>` : ''}
      </span>` : ''}
      <p>or try these examples:</p>
      <a class="button" href="?iiif-content=${encodeURIComponent('https://t-pen.org/TPEN/manifest/4080')}">T-PEN (unauthorized)</a>
      <a class="button" href="?iiif-content=${encodeURIComponent('https://www.e-codices.unifr.ch/metadata/iiif/bge-cl0015/manifest.json')}">e-codices (Classic IIIF, no text)</a>
      ${s.error ? `<p class="alert alert-danger">${escapeHtml(s.error)}</p>` : ''}
    </div>`;
  }

  collectionTemplate() {
    const s = this.state;
    const r = s.resource;
    return `<div class="container">
      <div class="note u-see-thru">
        <h3 class="note-header text">${escapeHtml(r.label || '[ no label ]')}
          <button title="clear" class="button" data-action="clear"><i class="fa fa-bomb"></i></button>
        </h3>
        <div class="note-block">
          ${(r.manifests || []).map((m) => `<p><a href="?iiif-content=${encodeURIComponent(m.id)}">${escapeHtml(m.label || m.id)}</a></p>`).join('') || '<p>[ no manifests ]</p>'}
        </div>
      </div>
    </div>`;
  }

  viewerTemplate() {
    const s = this.state;
    const r = s.resource;
    const canvas = (r.canvases || [])[s.canvasIndex];
    const languages = this.getLanguages(r);
    return `<div class="container">
      <div class="note u-see-thru">
        <h3 class="note-header text">${escapeHtml(r.label || '[ no label ]')}
          <button title="clear" class="button" data-action="clear"><i class="fa fa-bomb"></i></button>
        </h3>
        <div class="note-block text">
          ${escapeHtml(this.currentDescription(r))}
          ${this.currentDescription(r) ? '' : '<code>[ no description ]</code>'}
          ${languages.length ? `<div class="btn-group u-full-width" data-toggle="buttons">${languages.map((l) => `<label class="btn btn-info ${s.language === l ? 'active' : ''}"><input type="radio" data-action="set-language" value="${escapeHtml(l)}" ${s.language === l ? 'checked' : ''}>${escapeHtml(l)}</label>`).join('')}</div>` : ''}
        </div>
        ${r.metadata.length ? `<div class="note-block" style="max-height: 12rem;overflow: auto;"><dl>${r.metadata.map((m) => `<dt>${escapeHtml(m.label)}</dt><dd class="text">${sanitizeHtml(m.value)}</dd>`).join('')}</dl></div>` : ''}
        <div class="btn-group note-footer">
          <button role="button" data-action="prev-canvas" ${s.canvasIndex < 1 ? 'disabled' : ''}>previous</button>
          <select data-action="canvas-select">
            ${(r.canvases || []).map((c, i) => `<option value="${escapeHtml(c.id || i)}" ${i === s.canvasIndex ? 'selected' : ''}>${escapeHtml(c.label || c.id || i)}</option>`).join('')}
          </select>
          <button role="button" data-action="next-canvas" ${s.canvasIndex >= (r.canvases || []).length - 1 ? 'disabled' : ''}>next</button>
          <button role="button" data-action="toggle-view">${s.view === 'image' ? 'annotations' : 'image'}</button>
          ${s.view === 'annotations' ? `<button role="button" data-action="toggle-block">${s.block ? 'Shades' : 'Simple'}</button>` : ''}
          <button role="button" data-action="open-share" title="Share"><i class="fa fa-share-alt"></i></button>
          <button role="button" data-action="open-settings" title="Settings"><i class="fa fa-cog"></i></button>
        </div>
      </div>
      <div style="position:relative;">
        <img id="backsplash" style="display:none;">
        ${s.view === 'image' ? this.imageTemplate(canvas) : this.annotationsTemplate(canvas)}
      </div>
      ${this.ldnPanelTemplate()}
      ${s.shareOpen ? this.shareModalTemplate() : ''}
      ${s.settingsOpen ? this.settingsModalTemplate() : ''}
    </div>`;
  }

  imageTemplate(canvas) {
    const s = this.state;
    const image = (canvas.images || [])[0];
    if (!image) return '<p>[ no image found for this canvas ]</p>';
    if (s.region) {
      return `<div class="region-view">
        <canvas data-crop="${escapeHtml(s.region)}" class="region-canvas"></canvas>
        <p>Provenance: <a href="${escapeHtml(buildUrl(window.location.href, { 'iiif-content': s.resource.id, manifest: null }))}">view the full resource</a></p>
      </div>`;
    }
    const overlays = (canvas.annotations || [])
      .filter((a) => a.selector && !a.external)
      .map((a) => {
        const xywh = parseXYWH(a.selector);
        if (!xywh) return '';
        const [x, y, w, h] = xywh;
        const style = `left:${(x / canvas.width) * 100}%;top:${(y / canvas.height) * 100}%;width:${(w / canvas.width) * 100}%;height:${(h / canvas.height) * 100}%;`;
        const cls = ['annotation'];
        if (a.source === 'ldn') cls.push('ldn-annotation');
        if (a.id && a.id === s.focusAnnotation) cls.push('focused');
        return `<div class="${cls.join(' ')}" data-anno="${escapeHtml(a.id || '')}" data-action="select-annotation" data-uri="${escapeHtml(a.id || '')}" data-content="${escapeHtml(a.text || '')}" style="${style}"></div>`;
      }).join('');
    return `<img class="canvas-image" src="${escapeHtml(image.id)}" alt="${escapeHtml(canvas.label || '')}">${overlays}`;
  }

  annotationsTemplate(canvas) {
    const s = this.state;
    const annos = (canvas.annotations || []).filter((a) => !a.external);
    return `<div class="note u-see-thru ${s.block ? 'block' : ''}">
      <div class="note-block">
        ${annos.map((a) => {
          const cls = ['text-annotation'];
          if (a.source === 'ldn') cls.push('ldn-annotation');
          if (a.id && a.id === s.focusAnnotation) cls.push('focused');
          return `<div class="${cls.join(' ')}" data-anno="${escapeHtml(a.id || '')}" data-action="select-annotation" data-uri="${escapeHtml(a.id || '')}" data-content="${escapeHtml(a.text || '')}">
            <div>
              ${a.label ? `<strong>${escapeHtml(a.label)}</strong> ` : ''}<span class="text">${sanitizeHtml(a.text)}</span>
              ${a.text ? '' : '<code>[ no transcription ]</code>'}
            </div>
            ${a.selector ? `<canvas data-crop="${escapeHtml(a.selector)}" class="crop-canvas"></canvas>` : ''}
          </div>`;
        }).join('') || '<p>[ no annotations ]</p>'}
      </div>
    </div>`;
  }

  ldnPanelTemplate() {
    const s = this.state;
    if (!s.ldn.checked || !s.ldn.results.length) return '';
    return `<div class="ldn-panel note">
      <div class="note-header">LDN Inbox results (${s.ldn.results.length})</div>
      <div class="note-block">
        ${s.ldn.results.map((a) => `<div class="ldn-result">
          <span class="text">${sanitizeHtml(a.text || a.id || '[ no text ]')}</span>
          ${s.ldn.included.has(a.id) ? '<em>included</em>' : `<button role="button" data-action="include-ldn" data-anno="${escapeHtml(a.id || '')}">Include</button>`}
        </div>`).join('')}
      </div>
    </div>`;
  }

  shareModalTemplate() {
    const s = this.state;
    const r = s.resource;
    const canvas = (r.canvases || [])[s.canvasIndex];
    const anno = this.getFocusedAnnotation();
    const base = { 'iiif-content': r.id, manifest: null };
    if (canvas && canvas.id) base.canvas = canvas.id;
    const fullUrl = anno && anno.id
      ? buildUrl(window.location.href, { ...base, annotation: anno.id })
      : buildUrl(window.location.href, base);
    const boundedUrl = anno && anno.selector
      ? buildUrl(window.location.href, { ...base, region: anno.selector, annotation: anno.id })
      : null;
    const deepUrl = anno && anno.id
      ? buildUrl(window.location.href, { 'iiif-content': anno.id, manifest: null })
      : null;
    return `<div class="modal-overlay" data-action="close-share">
      <div class="modal">
        <h3>Share</h3>
        <p>${anno ? `Annotation: <code>${escapeHtml(anno.id || '')}</code>` : 'Current canvas'}</p>
        ${boundedUrl ? `<div class="share-option">
          <strong>Bounded area as image</strong>
          <input readonly value="${escapeHtml(boundedUrl)}">
          <button role="button" data-action="copy-bounded" data-url="${escapeHtml(boundedUrl)}">Copy</button>
          <button role="button" data-action="download-crop">Download PNG</button>
          <small>Provenance: <a href="${escapeHtml(buildUrl(window.location.href, base))}">full resource</a></small>
        </div>` : ''}
        <div class="share-option">
          <strong>${anno ? 'Full image with annotation selected' : 'Full image'}</strong>
          <input readonly value="${escapeHtml(fullUrl)}">
          <button role="button" data-action="copy-full" data-url="${escapeHtml(fullUrl)}">Copy</button>
        </div>
        ${deepUrl ? `<div class="share-option">
          <strong>Deep link to annotation</strong>
          <input readonly value="${escapeHtml(deepUrl)}">
          <button role="button" data-action="copy-deep" data-url="${escapeHtml(deepUrl)}">Copy</button>
        </div>` : ''}
        <button role="button" data-action="close-share">Close</button>
      </div>
    </div>`;
  }

  settingsModalTemplate() {
    const inboxes = getInboxes();
    return `<div class="modal-overlay" data-action="close-settings">
      <div class="modal">
        <h3>Settings</h3>
        <label><input type="checkbox" data-action="ldn-optin" ${getOptIn() ? 'checked' : ''}> Include annotations from LDN inboxes</label>
        <h4>LDN Inboxes</h4>
        <ul class="inbox-list">
          ${inboxes.map((i) => `<li>${escapeHtml(i)} <button role="button" data-action="remove-inbox" data-inbox="${escapeHtml(i)}">×</button></li>`).join('')}
        </ul>
        <div class="row">
          <input type="url" id="new-inbox-input" placeholder="https://inbox.rerum.io/messages" class="six columns">
          <button role="button" data-action="add-inbox">Add</button>
        </div>
        <button role="button" data-action="close-settings">Close</button>
      </div>
    </div>`;
  }

  async hydrateCrops() {
    const canvas = (this.state.resource?.canvases || [])[this.state.canvasIndex];
    if (!canvas || !canvas.images[0]) return;
    const image = canvas.images[0];
    for (const el of this.querySelectorAll('[data-crop]')) {
      const xywh = parseXYWH(el.dataset.crop);
      if (!xywh) continue;
      const result = await cropImage(image.id, canvas.width, canvas.height, xywh);
      if (result.dataUrl) {
        const img = document.createElement('img');
        img.src = result.dataUrl;
        img.alt = '';
        el.replaceWith(img);
      } else if (result.canvas) {
        result.canvas.style.width = '100%';
        result.canvas.style.maxWidth = '100%';
        result.canvas.style.maxHeight = '100%';
        el.replaceWith(result.canvas);
      }
    }
  }
}

customElements.define('read-viewer', ReadViewer);
