(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AiStatus = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function pillState(payload) {
    const providerAvailable = Boolean(payload?.aiProviderAvailable ?? payload?.aiProvider?.available);
    const status = payload?.classificationStatus;
    if (!providerAvailable) return { text: "KI-Kommentierung inaktiv", off: true };
    if (status === "success") return { text: "KI-Kommentierung aktiv", off: false };
    if (status === "partial") return { text: "KI-Kommentierung teilweise aktiv", off: false };
    if (status === "no_input" && providerAvailable) return { text: "KI-Kommentierung bereit", off: false };
    if (status === "failed" && providerAvailable) return { text: "KI-Kommentierung fehlgeschlagen", off: true };
    if (status === "unavailable") return { text: "KI-Kommentierung inaktiv", off: true };
    // Backward-compatible handling for responses from older servers.
    return { text: payload?.aiEnabled ? "KI-Kommentierung aktiv" : "KI-Kommentierung inaktiv", off: !payload?.aiEnabled };
  }

  return { pillState };
});
