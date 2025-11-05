import React, { useEffect, useRef, useState } from "react";

/**
 * RAG Console — UI para tu backend FastAPI
 * - API base por defecto: "/api" (funciona detrás de Nginx proxy en Docker)
 * - Endpoints: /health, /ingest_path, /ingest_files, /ingest_one, /chat
 */

export default function RAGConsole() {
  // En producción (Docker + Nginx), /api → rag-api:8000
  const [apiBase, setApiBase] = useState(() => localStorage.getItem("apiBase") || "/api");
  const [health, setHealth] = useState<string>("—");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<Array<{ q: string; a: string; used: number; t: number }>>([]);

  const [ingestFilename, setIngestFilename] = useState("");
  const [maxPages, setMaxPages] = useState<number | "">(10);
  const [maxChunks, setMaxChunks] = useState<number | "">(100);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem("apiBase", apiBase);
  }, [apiBase]);

  useEffect(() => {
    checkHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkHealth() {
    try {
      const r = await fetch(`${apiBase}/health`);
      const data = await r.json();
      setHealth(data.status || "ok");
    } catch {
      setHealth("offline");
    }
  }

  async function handleChat() {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    try {
      const r = await fetch(`${apiBase}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`);
      const data = await r.json();
      setHistory((h) => [{ q, a: data.answer ?? "", used: data.used_docs ?? 0, t: Date.now() }, ...h]);
      setQuestion("");
    } catch (e: any) {
      setToast(e?.message || "Chat error");
    } finally {
      setBusy(false);
    }
  }

  async function handleIngestPath() {
    setBusy(true);
    try {
      const r = await fetch(`${apiBase}/ingest_path`, { method: "POST" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const data = await r.json();
      setToast(`Ingestados: ${data.inserted} · Ficheros: ${data.files?.length ?? 0}`);
    } catch (e: any) {
      setToast(e?.message || "Ingesta fallida");
    } finally {
      setBusy(false);
    }
  }

  async function handleIngestFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append("files", f));
      const r = await fetch(`${apiBase}/ingest_files`, { method: "POST", body: fd });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const data = await r.json();
      setToast(`Ingestados: ${data.inserted} · Procesados: ${data.files?.join(", ")}`);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e: any) {
      setToast(e?.message || "Ingesta por archivos fallida");
    } finally {
      setBusy(false);
    }
  }

  async function handleIngestOne() {
    if (!ingestFilename.trim()) {
      setToast("Pon un nombre de fichero (en /app/data/docs)");
      return;
    }
    const params = new URLSearchParams();
    params.set("filename", ingestFilename.trim());
    if (maxPages !== "") params.set("max_pages", String(maxPages));
    if (maxChunks !== "") params.set("max_chunks", String(maxChunks));
    setBusy(true);
    try {
      const r = await fetch(`${apiBase}/ingest_one?${params.toString()}`, { method: "POST" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const data = await r.json();
      setToast(`Ingestado: ${data.inserted} chunks de ${data.files?.[0] ?? ingestFilename}`);
    } catch (e: any) {
      setToast(e?.message || "Ingesta puntual fallida");
    } finally {
      setBusy(false);
    }
  }

  function Dropzone() {
    const [drag, setDrag] = useState(false);
    return (
      <label
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); handleIngestFiles(e.dataTransfer.files); }}
        className={`block w-full rounded-2xl border-2 border-dashed p-6 text-center cursor-pointer transition ${
          drag ? "border-indigo-500 bg-indigo-50" : "border-gray-300 hover:border-indigo-300"
        }`}
      >
        <div className="text-sm text-gray-600">
          <strong>Arrastra y suelta</strong> PDFs/TXT/MD aquí, o pulsa para elegir archivos.
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.txt,.md"
          className="hidden"
          onChange={(e) => handleIngestFiles(e.target.files)}
        />
      </label>
    );
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-white to-slate-50 text-slate-900">
      {/* Header */}
      <header className="sticky top-0 backdrop-blur bg-white/70 border-b border-slate-200 z-10">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">RAG Console</h1>
          <div className="flex items-center gap-3 text-sm">
            <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border ${health === "ok" ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-rose-300 bg-rose-50 text-rose-700"}`}>
              <span className={`h-2 w-2 rounded-full ${health === "ok" ? "bg-emerald-500" : "bg-rose-500"}`} />
              API: {health}
            </span>
            <button onClick={checkHealth} className="rounded-xl px-3 py-1.5 border bg-white hover:bg-slate-50">Revisar</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 grid gap-6 md:grid-cols-3">
        {/* Settings */}
        <section className="md:col-span-1">
          <div className="rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold mb-3">Ajustes</h2>
            <label className="block text-sm mb-1">API Base</label>
            <input
              value={apiBase}
              onChange={(e) => setApiBase(e.target.value)}
              className="w-full rounded-xl border px-3 py-2 mb-3 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="/api"
            />
            <p className="text-xs text-slate-500 mb-4">En Docker/Nginx, deja “/api”. Para pruebas fuera del proxy, usa p.ej. http://IP:8010</p>

            <div className="h-px bg-slate-200 my-4" />
            <h3 className="font-medium mb-2">Ingesta puntual</h3>
            <label className="block text-sm mb-1">Nombre de fichero (en /app/data/docs)</label>
            <input
              value={ingestFilename}
              onChange={(e) => setIngestFilename(e.target.value)}
              className="w-full rounded-xl border px-3 py-2 mb-3"
              placeholder="mi_doc.pdf"
            />
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-sm mb-1">Máx. páginas (PDF)</label>
                <input
                  type="number"
                  value={maxPages as number}
                  onChange={(e) => setMaxPages(e.target.value === "" ? "" : Number(e.target.value))}
                  className="w-full rounded-xl border px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm mb-1">Máx. chunks</label>
                <input
                  type="number"
                  value={maxChunks as number}
                  onChange={(e) => setMaxChunks(e.target.value === "" ? "" : Number(e.target.value))}
                  className="w-full rounded-xl border px-3 py-2"
                />
              </div>
            </div>
            <button
              onClick={handleIngestOne}
              disabled={busy}
              className={`w-full rounded-xl px-4 py-2 font-medium text-white transition ${busy ? "bg-indigo-300" : "bg-indigo-600 hover:bg-indigo-700"}`}
            >Ingestar 1 archivo</button>
          </div>
        </section>

        {/* Ingest & Chat */}
        <section className="md:col-span-2 grid gap-6">
          <div className="rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold mb-3">Ingesta de documentos</h2>
            <div className="grid md:grid-cols-2 gap-4">
              <Dropzone />
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                  className={`rounded-xl px-4 py-2 font-medium border ${busy ? "bg-slate-100" : "bg-white hover:bg-slate-50"}`}
                >Elegir archivos…</button>
                <button
                  onClick={handleIngestPath}
                  disabled={busy}
                  className={`rounded-xl px-4 py-2 font-medium text-white transition ${busy ? "bg-emerald-300" : "bg-emerald-600 hover:bg-emerald-700"}`}
                >Ingestar carpeta /data/docs</button>
                <p className="text-xs text-slate-500">Soporta .pdf, .txt, .md. Los archivos se almacenan en Milvus como chunks vectorizados.</p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold mb-3">Chat</h2>
            <div className="flex flex-col md:flex-row gap-3">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChat(); } }}
                placeholder="Pregunta usando el contenido de tus documentos…"
                className="flex-1 rounded-xl border px-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                onClick={handleChat}
                disabled={busy}
                className={`rounded-xl px-6 py-3 font-medium text-white transition ${busy ? "bg-indigo-300" : "bg-indigo-600 hover:bg-indigo-700"}`}
              >Preguntar</button>
            </div>

            {/* Historial */}
            <div className="mt-5 grid gap-4">
              {history.length === 0 && (
                <p className="text-sm text-slate-500">No hay mensajes aún. Ingresa documentos y realiza tu primera pregunta ✨</p>
              )}
              {history.map((m) => (
                <div key={m.t} className="rounded-xl border p-4 bg-slate-50">
                  <div className="text-slate-600 text-sm">Tú</div>
                  <div className="font-medium whitespace-pre-wrap">{m.q}</div>
                  <div className="h-px bg-slate-200 my-3" />
                  <div className="text-slate-600 text-sm">Asistente</div>
                  <div className="whitespace-pre-wrap leading-relaxed">{m.a}</div>
                  <div className="mt-2 text-xs text-slate-500">Chunks usados: {m.used}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50">
          <div className="rounded-xl border bg-white shadow-xl px-4 py-3 flex items-center gap-3">
            <div className="text-sm">{toast}</div>
            <button onClick={() => setToast(null)} className="text-slate-500 hover:text-slate-700 text-sm">Cerrar</button>
          </div>
        </div>
      )}

      {/* Busy overlay */}
      {busy && (
        <div className="fixed inset-0 bg-white/40 backdrop-blur-sm grid place-items-center z-40">
          <div className="animate-pulse rounded-xl border bg-white px-4 py-3 shadow">Trabajando…</div>
        </div>
      )}
    </div>
  );
}
