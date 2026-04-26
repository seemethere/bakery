import { PROTOCOL_VERSION, type ServerEnvelope, type WebSession, type Workspace } from "@pi-web-agent/protocol";
import "./styles.css";

class PiWebAgentApp extends HTMLElement {
  private token = localStorage.getItem("piWebAuthToken") ?? "";
  private apiBase = localStorage.getItem("piWebApiBase") ?? "http://127.0.0.1:3141";
  private sessions: WebSession[] = [];
  private workspaces: Workspace[] = [];
  private selectedSession: WebSession | null = null;
  private ws: WebSocket | null = null;
  private log: string[] = [];

  connectedCallback(): void {
    this.render();
    void this.refresh();
  }

  disconnectedCallback(): void {
    this.ws?.close();
  }

  private headers(): HeadersInit {
    return this.token ? { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, { ...init, headers: { ...this.headers(), ...init?.headers } });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private async refresh(): Promise<void> {
    try {
      const [workspaces, sessions] = await Promise.all([
        this.api<Workspace[]>("/api/workspaces"),
        this.api<WebSession[]>("/api/sessions"),
      ]);
      this.workspaces = workspaces;
      this.sessions = sessions;
      this.render();
    } catch (error) {
      this.log.push(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      this.render();
    }
  }

  private async createSession(): Promise<void> {
    const select = this.querySelector<HTMLSelectElement>("#workspace");
    const cwd = select?.value || this.workspaces[0]?.path;
    if (!cwd) return;
    const session = await this.api<WebSession>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd }),
    });
    this.sessions = [session, ...this.sessions];
    this.openSession(session);
  }

  private openSession(session: WebSession): void {
    this.selectedSession = session;
    this.log = [`Opened ${session.cwd}`];
    this.ws?.close();

    const url = new URL(`${this.apiBase}/api/sessions/${session.id}/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (this.token) url.searchParams.set("token", this.token);

    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => {
      const data = JSON.parse(event.data as string) as ServerEnvelope | { type: string };
      if ("payload" in data) this.log.push(JSON.stringify(data.payload));
      else if (data.type === "hello") this.ws?.send(JSON.stringify({ type: "hello_ack", protocolVersion: PROTOCOL_VERSION }));
      else this.log.push(JSON.stringify(data));
      this.render();
    });
    this.ws.addEventListener("close", () => {
      this.log.push("WebSocket closed");
      this.render();
    });
    this.render();
  }

  private sendPrompt(): void {
    const input = this.querySelector<HTMLTextAreaElement>("#prompt");
    const text = input?.value.trim();
    if (!input || !text || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "prompt", text }));
    input.value = "";
  }

  private bindEvents(): void {
    this.querySelector<HTMLButtonElement>("#saveSettings")?.addEventListener("click", () => {
      const apiBase = this.querySelector<HTMLInputElement>("#apiBase")?.value.trim();
      const token = this.querySelector<HTMLInputElement>("#token")?.value.trim() ?? "";
      if (apiBase) {
        this.apiBase = apiBase;
        localStorage.setItem("piWebApiBase", apiBase);
      }
      this.token = token;
      localStorage.setItem("piWebAuthToken", token);
      void this.refresh();
    });
    this.querySelector<HTMLButtonElement>("#newSession")?.addEventListener("click", () => void this.createSession());
    this.querySelector<HTMLButtonElement>("#send")?.addEventListener("click", () => this.sendPrompt());
    this.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        this.sendPrompt();
      }
    });
    this.querySelectorAll<HTMLButtonElement>("[data-session-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const session = this.sessions.find((candidate) => candidate.id === button.dataset.sessionId);
        if (session) this.openSession(session);
      });
    });
  }

  private render(): void {
    this.innerHTML = `
      <aside>
        <h1>Pi Web Agent</h1>
        <label>API <input id="apiBase" value="${this.apiBase}" /></label>
        <label>Token <input id="token" type="password" value="${this.token}" /></label>
        <button id="saveSettings">Save / Refresh</button>
        <hr />
        <label>Workspace
          <select id="workspace">
            ${this.workspaces.map((workspace) => `<option value="${workspace.path}">${workspace.label} — ${workspace.path}</option>`).join("")}
          </select>
        </label>
        <button id="newSession">New session</button>
        <h2>Sessions</h2>
        <div class="sessions">
          ${this.sessions.map((session) => `<button data-session-id="${session.id}" class="${session.id === this.selectedSession?.id ? "active" : ""}">${session.title ?? session.cwd}<small>${session.id}</small></button>`).join("")}
        </div>
      </aside>
      <main>
        <header>${this.selectedSession ? `<strong>${this.selectedSession.cwd}</strong>` : "Create or open a session"}</header>
        <section class="transcript">${this.log.map((line) => `<pre>${line.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c)}</pre>`).join("")}</section>
        <footer>
          <textarea id="prompt" placeholder="Prompt pi..."></textarea>
          <button id="send">Send</button>
        </footer>
      </main>
    `;
    this.bindEvents();
  }
}

customElements.define("pi-web-agent", PiWebAgentApp);
