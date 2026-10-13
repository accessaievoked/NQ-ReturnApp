// The behaviour of the return form, served inline with the page. It attaches to the fixed data-er-* hooks documented in
// return-form-template.ts, never to markup a merchant might rewrite, so any template keeps working as long as the hooks
// stay. Plain JavaScript on purpose: it runs on a public storefront page with no build step.
//
// What it does: item selection, quantity/reason/note, photo resize + upload, return/exchange choice with replacement
// pickers, validation with friendly messages, and the submit. The server re-validates everything — this is convenience.

export const RETURN_FORM_SCRIPT = String.raw`
(function () {
  "use strict";
  var root = document.querySelector(".er-root");
  if (!root) return;
  var form = root.querySelector("[data-er-form]");
  if (!form) return; // e.g. the email-confirmation screen has no form to wire

  var MAX_PHOTOS = 3;
  var photoMode = root.getAttribute("data-photo-mode") || "OPTIONAL";
  var requireNote = root.getAttribute("data-require-note") === "true";
  var errorEl = root.querySelector("[data-er-error]");
  var doneEl = root.querySelector("[data-er-done]");
  var submitBtn = root.querySelector("[data-er-submit]");
  var items = Array.prototype.slice.call(root.querySelectorAll("[data-er-item]"));
  var photos = new Map(); // item element -> [{ status, id, preview, error }]

  function endpoint(name) { return new URL(name, window.location.href).toString(); }
  function showError(msg) { if (!errorEl) return; errorEl.textContent = msg || ""; errorEl.hidden = !msg; if (msg) errorEl.scrollIntoView({ block: "center", behavior: "smooth" }); }
  function q(el, sel) { return el.querySelector(sel); }
  function currentType() { var r = root.querySelector("[data-er-type]:checked"); return r ? r.value : "RETURN"; }
  function picked(it) { var p = q(it, "[data-er-pick]"); return !!(p && p.checked); }
  function title(it) { var n = q(it, ".er-name"); return n ? n.textContent : "this item"; }

  function post(name, body) {
    return fetch(endpoint(name), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (json) {
          if (!res.ok || !json || !json.ok) throw new Error((json && json.error) || "Something went wrong. Please try again.");
          return json.data;
        });
      })
      .catch(function (err) {
        if (err instanceof TypeError) throw new Error("We couldn't reach the store. Check your connection and try again.");
        throw err;
      });
  }

  // ---- selecting items, and showing the exchange pickers only when exchanging
  function syncExchange() {
    var exchanging = currentType() === "EXCHANGE";
    items.forEach(function (it) { var w = q(it, "[data-er-exchange]"); if (w) w.hidden = !(exchanging && picked(it)); });
  }
  items.forEach(function (it) {
    var pick = q(it, "[data-er-pick]");
    var more = q(it, "[data-er-more]");
    if (!pick) return;
    pick.addEventListener("change", function () {
      it.classList.toggle("is-selected", pick.checked);
      if (more) more.hidden = !pick.checked;
      syncExchange();
      showError("");
    });
    var input = q(it, "[data-er-photo-input]");
    if (input) input.addEventListener("change", function () { addPhotos(it, input.files); input.value = ""; });
  });
  Array.prototype.forEach.call(root.querySelectorAll("[data-er-type]"), function (r) { r.addEventListener("change", syncExchange); });
  syncExchange();

  // ---- photos: shrink to a ~1280px JPEG under ~450 KB, upload one by one
  var prepare = window.__erPrepare || function (file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
          var quality = 0.82, data = "";
          for (var n = 0; n < 6; n++) {
            var c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(img.naturalWidth * scale));
            c.height = Math.max(1, Math.round(img.naturalHeight * scale));
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            data = c.toDataURL("image/jpeg", quality);
            if (data.length * 0.75 < 450000) break;
            quality = Math.max(0.5, quality - 0.1);
            scale *= 0.85;
          }
          resolve({ base64: data.split(",")[1], mime: "image/jpeg", preview: url });
        } catch (e) { URL.revokeObjectURL(url); reject(new Error("That photo could not be processed.")); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("That file could not be read as a photo.")); };
      img.src = url;
    });
  };

  function drawPhotos(it) {
    var box = q(it, "[data-er-thumbs]");
    var list = photos.get(it) || [];
    if (box) {
      box.innerHTML = "";
      list.forEach(function (p, i) {
        var d = document.createElement("div");
        d.className = "er-photo" + (p.status === "error" ? " is-error" : "");
        if (p.preview) { var im = document.createElement("img"); im.src = p.preview; im.alt = "Your photo"; d.appendChild(im); }
        if (p.status === "uploading") { var s = document.createElement("span"); s.className = "er-spin"; d.appendChild(s); }
        var x = document.createElement("button");
        x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "Remove photo");
        x.addEventListener("click", function () { list.splice(i, 1); drawPhotos(it); });
        d.appendChild(x);
        if (p.status === "error" && p.error) d.title = p.error;
        box.appendChild(d);
      });
    }
    var add = q(it, ".er-add");
    if (add) add.hidden = list.length >= MAX_PHOTOS;
  }

  function addPhotos(it, files) {
    if (!files) return;
    var list = photos.get(it) || [];
    photos.set(it, list);
    var room = MAX_PHOTOS - list.length;
    Array.prototype.slice.call(files, 0, Math.max(room, 0)).forEach(function (file) {
      var entry = { status: "uploading", id: "", preview: "", error: "" };
      list.push(entry);
      prepare(file)
        .then(function (img) { entry.preview = img.preview; drawPhotos(it); return post("upload", { data: img.base64, mime: img.mime }); })
        .then(function (r) { entry.status = "done"; entry.id = r.id; drawPhotos(it); })
        .catch(function (e) { entry.status = "error"; entry.error = e.message; drawPhotos(it); showError(e.message); });
    });
    drawPhotos(it);
  }

  // ---- submit
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    showError("");
    var chosen = items.filter(picked);
    if (!chosen.length) return showError("Select at least one item.");
    var type = currentType();
    var payloadItems = [];
    var replacements = [];
    for (var i = 0; i < chosen.length; i++) {
      var it = chosen[i];
      var reason = q(it, "[data-er-reason]");
      var note = q(it, "[data-er-note]");
      var qty = q(it, "[data-er-qty]");
      var list = photos.get(it) || [];
      if (reason && reason.options.length > 1 && !reason.value) return showError("Choose a reason for “" + title(it) + "”.");
      if (requireNote && !(note && note.value.trim())) return showError("Tell us a little more about “" + title(it) + "”.");
      if (list.some(function (p) { return p.status === "uploading"; })) return showError("Please wait for your photos to finish uploading.");
      var done = list.filter(function (p) { return p.status === "done"; });
      if (photoMode === "REQUIRED" && q(it, "[data-er-photo-input]") && !done.length) return showError("Add a photo of “" + title(it) + "”.");
      var key = it.getAttribute("data-key");
      payloadItems.push({ key: key, quantity: qty ? Number(qty.value) : 1, reasonId: reason ? reason.value : "", note: note ? note.value : "", photos: done.map(function (p) { return p.id; }) });
      if (type === "EXCHANGE") {
        var rep = q(it, "[data-er-replacement]");
        if (!rep || !rep.value) return showError("Pick a replacement for “" + title(it) + "”.");
        replacements.push({ forKey: key, variantId: rep.value });
      }
    }
    if (window.__erPreview) return showError("This is a preview, so nothing was sent.");
    if (submitBtn) submitBtn.disabled = true;
    post("submit", { orderId: root.getAttribute("data-order-id"), email: root.getAttribute("data-email") || "", type: type, items: payloadItems, replacements: replacements })
      .then(function (r) {
        form.hidden = true;
        var ref = root.querySelector("[data-er-ref]");
        if (ref) ref.textContent = r.kind === "EXCHANGE" ? r.code : r.name;
        if (doneEl) { doneEl.hidden = false; var h = q(doneEl, "h1"); if (h) h.focus(); doneEl.scrollIntoView({ block: "center", behavior: "smooth" }); }
      })
      .catch(function (err) { showError(err.message); if (submitBtn) submitBtn.disabled = false; });
  });
})();
`;
