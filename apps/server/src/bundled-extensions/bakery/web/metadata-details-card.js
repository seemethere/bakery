class BakeryMetadataDetailsCard extends HTMLElement {
  static get observedAttributes() { return ["data-extension-card-props"]; }

  connectedCallback() { this.render(); }
  attributeChangedCallback() { this.render(); }

  props() {
    try { return JSON.parse(this.getAttribute("data-extension-card-props") || "{}"); }
    catch { return {}; }
  }

  escape(value) {
    return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] || char));
  }

  render() {
    const data = this.props();
    const applied = new Set(Array.isArray(data.applied) ? data.applied.map(String) : []);
    const skipped = Array.isArray(data.skipped) ? data.skipped.filter((entry) => entry && typeof entry === "object") : [];
    const deferred = data.deferred === true;
    const status = deferred ? "Details not ready" : applied.size > 0 ? "Details generated" : skipped.length > 0 ? "Manual details protected" : "No details changed";
    const changed = [applied.has("title") ? "title" : "", applied.has("summary") ? "summary" : ""].filter(Boolean).join(" and ");
    const title = typeof data.title === "string" ? data.title : "";
    const summary = typeof data.summary === "string" ? data.summary : typeof data.reason === "string" ? data.reason : "No generated summary returned.";
    const skippedNote = skipped.map((entry) => `Skipped ${this.escape(entry.field ?? "field")}: ${this.escape(entry.reason ?? "protected")}. Use <code>--replace</code> to overwrite.`).join(" ");
    this.innerHTML = `<article class="metadata-details-card ${deferred ? "deferred" : ""}" aria-label="Session metadata generation result">
      <div class="metadata-details-card-header">
        <span class="metadata-details-kicker">${this.escape(status)}</span>
        ${changed ? `<span class="metadata-details-open-hint">Updated ${this.escape(changed)}</span>` : ""}
      </div>
      ${title ? `<div class="metadata-details-title">${this.escape(title)}</div>` : ""}
      <div class="metadata-details-summary">${this.escape(summary)}</div>
      ${skippedNote ? `<div class="metadata-details-note">${skippedNote}</div>` : ""}
    </article>`;
  }
}

customElements.define("bakery-metadata-details-card", BakeryMetadataDetailsCard);
