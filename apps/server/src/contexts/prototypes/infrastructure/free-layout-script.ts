/*
 * The script `ChromiumPrototypeRenderer.freeLayout` runs inside the page (`page.evaluate`). It is a
 * STRING of plain JavaScript on purpose: `page.evaluate(fn)` serializes `fn.toString()`, and a
 * bundler/test transformer that injects helpers (esbuild's `__name`) would break it in the page.
 * Do not use backticks or `${` inside it.
 *
 * What it does (see `PrototypeRenderer.freeLayout`): for every `[data-tf-layer]` root it copies the
 * root into an absolutely positioned `<div data-tf-free="n">` at the end of the body and hides the
 * original (`data-tf-free-src="n"`, `visibility:hidden`, so the frame keeps its layout). The copy
 * is still subject to the page's stylesheet but no longer matches its contextual selectors
 * (`form table td {...}`), so each copied element is compared with its original in the live page
 * and gets, inline, every property of a fixed list that differs. A container (group) copy loses the
 * layers inside it: they get their own wrappers and leave an invisible same-size placeholder, so
 * what remains in the group does not move. Finally each wrapper is moved until the copy sits
 * exactly where the original is. Returns `document.body.outerHTML`.
 */
export const FREE_LAYOUT_SCRIPT = String.raw`(() => {
  var BODY = document.body;
  var XHTML = 'http://www.w3.org/1999/xhtml';
  // layout values are multiples of 1/64 px: keep them exact (rounding to 2 decimals can lose 1/64)
  var q64 = function (v) { return Math.round(v * 64) / 64; };
  var px = function (v) { return q64(v) + 'px'; };
  // never smaller than the real size (a fraction less could wrap a tight line)
  var ceilPx = function (v) { return Math.ceil(v * 64 - 1e-6) / 64 + 'px'; };

  // compared with the same property of the copy in the live page; written inline when they differ
  var PROPS = ['font-family', 'font-size', 'font-weight', 'font-style', 'color', 'text-align',
    'line-height', 'white-space', 'text-transform', 'letter-spacing', 'word-spacing', 'text-indent',
    'list-style-type', 'list-style-position', 'border-collapse', 'border-spacing', 'visibility',
    'background-color', 'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-right-radius', 'border-bottom-left-radius', 'padding-top', 'padding-right',
    'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'vertical-align', 'text-decoration-line', 'display', 'box-sizing', 'position', 'float', 'clear',
    'overflow-x', 'overflow-y', 'text-overflow', 'box-shadow', 'opacity', 'table-layout'];
  var SIDES = ['top', 'right', 'bottom', 'left'];
  var SIZED = { input: 1, select: 1, textarea: 1, button: 1, img: 1, td: 1, th: 1, canvas: 1 };

  var cleanBackgroundImage = function (value) {
    if (value === 'none') return 'none';
    var urls = value.match(/url\(\s*["']?[^)]*\)/g) || [];
    for (var i = 0; i < urls.length; i++) {
      if (!/^url\(\s*["']?data:/i.test(urls[i])) return 'none';
    }
    return value;
  };

  var inlineBox = function (clone, rect) {
    clone.style.setProperty('box-sizing', 'border-box');
    clone.style.setProperty('width', ceilPx(rect.width));
    clone.style.setProperty('height', ceilPx(rect.height));
  };

  // makes the (attached) copy "clone" compute like "orig": inline every listed property that differs
  var matchStyle = function (orig, clone, isRoot) {
    if (orig.namespaceURI !== XHTML && orig.localName !== 'svg') return;
    var co = getComputedStyle(orig);
    var cc = getComputedStyle(clone);
    var diff = function (prop) { return co.getPropertyValue(prop) !== cc.getPropertyValue(prop); };
    if (co.getPropertyValue('display') === 'none') {
      clone.style.setProperty('display', 'none');
      return;
    }
    for (var i = 0; i < PROPS.length; i++) {
      if (diff(PROPS[i])) clone.style.setProperty(PROPS[i], co.getPropertyValue(PROPS[i]));
    }
    for (var s = 0; s < 4; s++) {
      var side = SIDES[s];
      var parts = ['width', 'style', 'color'];
      var changed = false;
      for (var a = 0; a < 3; a++) {
        if (diff('border-' + side + '-' + parts[a])) changed = true;
      }
      if (changed) {
        for (var b = 0; b < 3; b++) {
          clone.style.setProperty('border-' + side + '-' + parts[b],
            co.getPropertyValue('border-' + side + '-' + parts[b]));
        }
      }
    }
    var bg = cleanBackgroundImage(co.getPropertyValue('background-image'));
    if (bg !== cc.getPropertyValue('background-image')) {
      clone.style.setProperty('background-image', bg);
      if (bg !== 'none') {
        var extra = ['background-repeat', 'background-position', 'background-size'];
        for (var e = 0; e < 3; e++) clone.style.setProperty(extra[e], co.getPropertyValue(extra[e]));
      }
    }
    if (co.getPropertyValue('position') !== 'static') {
      for (var k = 0; k < 4; k++) {
        var off = co.getPropertyValue(SIDES[k]);
        if (off !== 'auto' && diff(SIDES[k])) clone.style.setProperty(SIDES[k], off);
      }
      var z = co.getPropertyValue('z-index');
      if (z !== 'auto' && diff('z-index')) clone.style.setProperty('z-index', z);
    }
    var overflowing = co.getPropertyValue('overflow-x') !== 'visible' ||
      co.getPropertyValue('overflow-y') !== 'visible';
    if (!isRoot && (SIZED[orig.localName] || overflowing)) inlineBox(clone, orig.getBoundingClientRect());
  };

  var isPlaceholder = function (el) { return el.nodeType === 1 && el.hasAttribute('data-tf-ph'); };
  var hasText = function (el) {
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && /\S/.test(n.nodeValue)) return true;
    }
    return false;
  };
  var FLOW = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'float', 'clear',
    'vertical-align'];

  // an invisible block with the box and flow behavior of "orig" (a layer that moved out)
  var boxPlaceholder = function (orig, cs, rect) {
    var display = cs.getPropertyValue('display');
    var ph = document.createElement('div');
    ph.style.cssText = 'visibility:hidden;display:' + (display.indexOf('inline') === 0 ? 'inline-block' : 'block');
    inlineBox(ph, rect);
    for (var m = 0; m < FLOW.length; m++) ph.style.setProperty(FLOW[m], cs.getPropertyValue(FLOW[m]));
    ph.setAttribute('data-tf-ph', '');
    return ph;
  };

  // an invisible stand-in with the size/flow of a layer that moved out of a container copy
  var placeholderFor = function (orig) {
    var cs = getComputedStyle(orig);
    var rect = orig.getBoundingClientRect();
    var tag = orig.localName;
    var position = cs.getPropertyValue('position');
    if (position === 'absolute' || position === 'fixed') return null; // takes no room in the flow
    if (tag !== 'tr' && tag !== 'td' && tag !== 'th') return boxPlaceholder(orig, cs, rect);
    var shell = function (cell) {
      var td = document.createElement(cell.localName === 'th' ? 'th' : 'td');
      if (cell.colSpan > 1) td.colSpan = cell.colSpan;
      if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
      td.style.cssText = 'padding:0;border:0;visibility:hidden';
      inlineBox(td, cell.getBoundingClientRect());
      return td;
    };
    var ph;
    if (tag === 'tr') {
      ph = document.createElement('tr');
      ph.style.cssText = 'visibility:hidden;height:' + ceilPx(rect.height);
      for (var i = 0; i < orig.children.length; i++) {
        var name = orig.children[i].localName;
        if (name === 'td' || name === 'th') ph.appendChild(shell(orig.children[i]));
      }
    } else {
      ph = shell(orig);
    }
    ph.setAttribute('data-tf-ph', '');
    return ph;
  };

  // whether the element draws anything itself (background, border, shadow)
  var paints = function (cs) {
    if (cs.getPropertyValue('background-color') !== 'rgba(0, 0, 0, 0)') return true;
    if (cs.getPropertyValue('background-image') !== 'none') return true;
    if (cs.getPropertyValue('box-shadow') !== 'none') return true;
    for (var s = 0; s < 4; s++) {
      var st = cs.getPropertyValue('border-' + SIDES[s] + '-style');
      if (st !== 'none' && st !== 'hidden' && parseFloat(cs.getPropertyValue('border-' + SIDES[s] + '-width')) > 0) return true;
    }
    return false;
  };

  // pass A, top-down: every element of the copy computes like its original
  var matchTree = function (orig, clone, isRoot) {
    matchStyle(orig, clone, isRoot);
    if (clone.localName === 'style' || clone.localName === 'svg') return;
    var o = orig.children;
    var c = clone.children;
    for (var i = 0; i < o.length && i < c.length; i++) matchTree(o[i], c[i], false);
  };

  // pass B: layers nested in a container copy are swapped for placeholders. Returns the element
  // that replaces "clone" (an element holding nothing but placeholders becomes one itself).
  var hollow = function (orig, clone, isRoot) {
    if (clone.localName === 'style' || clone.localName === 'svg') return clone;
    var origKids = Array.prototype.slice.call(orig.children);
    var cloneKids = Array.prototype.slice.call(clone.children);
    var onlyPlaceholders = origKids.length > 0;
    for (var i = 0; i < origKids.length && i < cloneKids.length; i++) {
      var o = origKids[i];
      var c = cloneKids[i];
      var next;
      if (o.hasAttribute('data-tf-layer')) {
        next = placeholderFor(o);
        if (!next) { clone.removeChild(c); continue; }
        clone.replaceChild(next, c);
      } else {
        next = hollow(o, c, false);
        if (next !== c) clone.replaceChild(next, c);
      }
      if (!isPlaceholder(next)) onlyPlaceholders = false;
    }
    if (!isRoot && onlyPlaceholders && !hasText(clone)) {
      var cs = getComputedStyle(orig);
      if (cs.getPropertyValue('display') !== 'none' && !paints(cs)) {
        return boxPlaceholder(orig, cs, orig.getBoundingClientRect());
      }
    }
    return clone;
  };

  var tableOf = function (el) {
    for (var t = el.parentElement; t; t = t.parentElement) if (t.localName === 'table') return t;
    return null;
  };
  var SECTIONS = { tbody: 1, thead: 1, tfoot: 1 };
  // the element whose position says where the copy is: a row's first cell, else the copy itself
  var anchorOf = function (el) {
    var tag = el.localName;
    if (tag === 'tr' || SECTIONS[tag]) return el.querySelector('td,th') || el;
    return el;
  };

  // the layout the final document has: body is the positioning context of the wrappers
  if (getComputedStyle(BODY).getPropertyValue('position') === 'static') {
    BODY.style.setProperty('position', 'relative');
  }

  var roots = Array.prototype.slice.call(document.querySelectorAll('[data-tf-layer]'))
    .map(function (el) { return { el: el, n: parseInt(el.getAttribute('data-tf-layer'), 10) }; })
    .filter(function (r) { return r.n >= 1; })
    .sort(function (a, b) { return a.n - b.n; });

  // measure before anything is added
  var todo = [];
  for (var r = 0; r < roots.length; r++) {
    var root = roots[r].el;
    var rect = root.getBoundingClientRect();
    var rcs = getComputedStyle(root);
    if (rect.width < 1 || rect.height < 1) continue;
    if (rcs.getPropertyValue('display') === 'none' || rcs.getPropertyValue('visibility') !== 'visible') continue;
    todo.push({ n: roots[r].n, root: root, rect: rect, anchorRect: anchorOf(root).getBoundingClientRect() });
  }

  var made = [];
  for (var t = 0; t < todo.length; t++) {
    var item = todo[t];
    var root2 = item.root;
    var tag = root2.localName;
    var clone = root2.cloneNode(true);
    var wrapped = clone;
    // ids would be duplicates of the (hidden) originals. They go BEFORE the styles are compared,
    // so what an "#id {...}" rule gave the original is inlined too
    clone.removeAttribute('id');
    var withId = clone.querySelectorAll('[id]');
    for (var d = 0; d < withId.length; d++) withId[d].removeAttribute('id');

    if (tag === 'tr' || tag === 'td' || tag === 'th' || SECTIONS[tag]) {
      var table = tableOf(root2);
      var tcs = table ? getComputedStyle(table) : null;
      var shellTable = document.createElement('table');
      shellTable.style.cssText = 'border-collapse:' + (tcs ? tcs.getPropertyValue('border-collapse') : 'separate') +
        ';border-spacing:' + (tcs ? tcs.getPropertyValue('border-spacing') : '0px') +
        ';margin:0;padding:0;border:0';
      if (SECTIONS[tag]) {
        shellTable.appendChild(clone);
      } else {
        var inner = clone;
        if (tag !== 'tr') {
          inner = document.createElement('tr');
          inner.appendChild(clone);
        }
        var section = document.createElement('tbody');
        section.appendChild(inner);
        shellTable.appendChild(section);
      }
      wrapped = shellTable;
    }
    var wrapper = document.createElement('div');
    wrapper.setAttribute('data-tf-free', String(item.n));
    wrapper.style.cssText = 'position:absolute;left:0;top:0;z-index:' + item.n + ';margin:0';
    wrapper.appendChild(wrapped);
    BODY.appendChild(wrapper);

    matchTree(root2, clone, true);
    if (tag === 'td' || tag === 'th') inlineBox(clone, item.rect);
    if (!(tag === 'tr' || tag === 'td' || tag === 'th' || SECTIONS[tag])) {
      // the copy sits alone in its wrapper: it keeps its box, nothing of its old surroundings
      var disp = getComputedStyle(root2).getPropertyValue('display');
      clone.style.setProperty('display', disp.indexOf('inline') === 0
        ? (disp === 'inline-flex' ? 'flex' : disp === 'inline-table' ? 'table' : 'block') : disp);
      inlineBox(clone, item.rect);
      clone.style.setProperty('position', 'relative');
      clone.style.setProperty('top', 'auto');
      clone.style.setProperty('left', 'auto');
      clone.style.setProperty('right', 'auto');
      clone.style.setProperty('bottom', 'auto');
      clone.style.setProperty('float', 'none');
      clone.style.setProperty('clear', 'none');
      clone.style.setProperty('margin', '0');
    }
    // an underline set by an ancestor of the root would be lost with it
    if (getComputedStyle(root2).getPropertyValue('text-decoration-line') === 'none') {
      for (var anc = root2.parentElement; anc; anc = anc.parentElement) {
        var line = getComputedStyle(anc).getPropertyValue('text-decoration-line');
        if (line !== 'none') { clone.style.setProperty('text-decoration-line', line); break; }
      }
    }
    hollow(root2, clone, true);

    // where the wrapper has to go for the copy to sit exactly on its original
    var at = anchorOf(clone).getBoundingClientRect();
    wrapper.style.setProperty('left', px(item.anchorRect.left - at.left));
    wrapper.style.setProperty('top', px(item.anchorRect.top - at.top));
    made.push({ n: item.n, root: root2 });
  }

  // hide the originals (they keep the frame's layout)
  for (var h = 0; h < made.length; h++) {
    made[h].root.setAttribute('data-tf-free-src', String(made[h].n));
    made[h].root.style.setProperty('visibility', 'hidden');
  }
  var leftovers = BODY.querySelectorAll('[data-tf-ph]');
  for (var x = 0; x < leftovers.length; x++) leftovers[x].removeAttribute('data-tf-ph');
  var marks = BODY.querySelectorAll('[data-tf-layer],[data-tf-container]');
  for (var y = 0; y < marks.length; y++) {
    marks[y].removeAttribute('data-tf-layer');
    marks[y].removeAttribute('data-tf-container');
  }
  return BODY.outerHTML;
})()`;
