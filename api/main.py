import os
import time
import uuid
from pathlib import Path
from typing import List, Optional

import requests
from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from pydantic import BaseModel
from pypdf import PdfReader
import fitz  # PyMuPDF
from requests.exceptions import RequestException, ReadTimeout
from pymilvus import (
    connections, utility,
    FieldSchema, CollectionSchema, DataType, Collection
)

# -----------------------------
# Configuración por variables
# -----------------------------
MILVUS_HOST = os.getenv("MILVUS_HOST", "milvus")
MILVUS_PORT = os.getenv("MILVUS_PORT", "19530")
OLLAMA_URL  = os.getenv("OLLAMA_URL", "http://ollama:11434")
EMBED_MODEL = os.getenv("EMBED_MODEL", "nomic-embed-text")  # embeddings en Ollama
GEN_MODEL   = os.getenv("GENERATION_MODEL", "mistral")      # LLM para generación
TOP_K       = int(os.getenv("TOP_K", "4"))

# Carpeta de datos en el contenedor (mapeada desde /opt/rag/data en el host)
DATA_DIR = Path("/app/data")
DOCS_DIR = DATA_DIR / "docs"
DOCS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="RAG API (Milvus + Ollama)")

# -----------------------------
# Lectura de documentos
# -----------------------------
def read_pdf_pypdf(p: Path, max_pages: Optional[int] = None) -> str:
    reader = PdfReader(str(p))
    pages = reader.pages[:max_pages] if max_pages else reader.pages
    return "\n".join((page.extract_text() or "") for page in pages)

def read_pdf_pymupdf(p: Path, max_pages: Optional[int] = None) -> str:
    text_parts = []
    with fitz.open(str(p)) as doc:
        total = len(doc)
        stop = min(total, max_pages) if max_pages else total
        for i in range(stop):
            page = doc[i]
            text_parts.append(page.get_text("text"))
    return "\n".join(text_parts).strip()

def read_pdf(p: Path, max_pages: Optional[int] = None) -> str:
    txt = ""
    try:
        txt = read_pdf_pypdf(p, max_pages=max_pages)
    except Exception:
        pass
    if not txt or len(txt.strip()) < 20:
        try:
            txt2 = read_pdf_pymupdf(p, max_pages=max_pages)
            if txt2 and len(txt2.strip()) > len(txt.strip()):
                txt = txt2
        except Exception:
            pass
    return txt or ""

def read_txt(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="ignore")

def load_document(p: Path, max_pages: Optional[int] = None) -> str:
    ext = p.suffix.lower()
    if ext in [".txt", ".md"]:
        return read_txt(p)
    if ext == ".pdf":
        return read_pdf(p, max_pages=max_pages)
    raise ValueError(f"Tipo de archivo no soportado: {ext}")

def chunk_text(
    text: str,
    chunk_size: int = 1200,
    overlap: int = 200,
    max_chunks: Optional[int] = None
) -> List[str]:
    """Split simple por líneas/párrafos + empaquetado por tamaño con solape."""
    paras = [t.strip() for t in text.split("\n") if t.strip()]
    chunks, buf = [], ""
    for para in paras:
        if len(buf) + len(para) + 1 <= chunk_size:
            buf = (buf + "\n" + para).strip()
        else:
            if buf:
                chunks.append(buf)
                if max_chunks and len(chunks) >= max_chunks:
                    return chunks
            tail = buf[-overlap:] if overlap and len(buf) > overlap else ""
            buf = (tail + "\n" + para).strip()
    if buf and (not max_chunks or len(chunks) < max_chunks):
        chunks.append(buf)
    return chunks

# -----------------------------
# Embeddings vía Ollama (con reintentos)
# -----------------------------
def embed_texts(texts: List[str]) -> List[List[float]]:
    out: List[List[float]] = []
    for t in texts:
        attempts = 0
        while True:
            try:
                r = requests.post(
                    f"{OLLAMA_URL}/api/embeddings",
                    json={"model": EMBED_MODEL, "prompt": t},
                    timeout=120
                )
                r.raise_for_status()
                out.append(r.json()["embedding"])
                break
            except (ReadTimeout, RequestException) as e:
                attempts += 1
                if attempts >= 3:
                    raise HTTPException(status_code=503, detail=f"Embeddings error: {e}")
                time.sleep(2 * attempts)  # backoff simple
    return out

# -----------------------------
# Conexión y colección Milvus
# -----------------------------
connections.connect("default", host=MILVUS_HOST, port=MILVUS_PORT)

COLLECTION = "docs"
DIM = 768  # dimensión para 'nomic-embed-text'

if not utility.has_collection(COLLECTION):
    fields = [
        FieldSchema(name="id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
        FieldSchema(name="vector", dtype=DataType.FLOAT_VECTOR, dim=DIM),
        FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=65535),
    ]
    schema = CollectionSchema(fields, "RAG collection")
    collection = Collection(name=COLLECTION, schema=schema, consistency_level="Strong")
else:
    collection = Collection(COLLECTION)

# Crea índice si falta y carga
try:
    has_index = any(idx.field_name == "vector" for idx in collection.indexes)
except Exception:
    has_index = False

if not has_index:
    collection.create_index(
        field_name="vector",
        index_params={"index_type": "IVF_FLAT", "metric_type": "IP", "params": {"nlist": 1024}}
    )
collection.load()

# -----------------------------
# Esquemas y Endpoints
# -----------------------------
@app.get("/health")
def health():
    return {"status": "ok"}

class IngestReport(BaseModel):
    inserted: int
    files: List[str]

@app.post("/ingest_path", response_model=IngestReport)
def ingest_path():
    files = []
    total = 0
    for p in DOCS_DIR.glob("*"):
        if p.suffix.lower() not in [".pdf", ".txt", ".md"]:
            continue
        try:
            raw = load_document(p)
            parts = chunk_text(raw)
            if not parts:
                files.append(f"{p.name} (sin texto)")
                continue
            vectors = embed_texts(parts)
            ids = [str(uuid.uuid4())[:8] for _ in parts]
            entities = [ids, vectors, parts]
            collection.insert(entities)
            total += len(ids)
            files.append(p.name)
        except Exception as e:
            files.append(f"{p.name} (ERROR: {e})")
    collection.flush()
    return IngestReport(inserted=total, files=files)

@app.post("/ingest_files", response_model=IngestReport)
async def ingest_files(files: List[UploadFile] = File(...)):
    saved = []
    total = 0
    for f in files:
        dest = DOCS_DIR / f.filename
        content = await f.read()
        dest.write_bytes(content)
        try:
            raw = load_document(dest)
            parts = chunk_text(raw)
            if not parts:
                saved.append(f"{f.filename} (sin texto)")
                continue
            vectors = embed_texts(parts)
            ids = [str(uuid.uuid4())[:8] for _ in parts]
            entities = [ids, vectors, parts]
            collection.insert(entities)
            total += len(ids)
            saved.append(f.filename)
        except Exception as e:
            saved.append(f"{f.filename} (ERROR: {e})")
    collection.flush()
    return IngestReport(inserted=total, files=saved)

@app.post("/ingest_one", response_model=IngestReport)
def ingest_one(
    filename: str = Query(..., description="Nombre del fichero en /app/data/docs"),
    max_pages: Optional[int] = Query(10, description="Máx. páginas del PDF (None = todas)"),
    max_chunks: Optional[int] = Query(100, description="Máx. chunks a insertar"),
):
    p = DOCS_DIR / filename
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"No existe: {p.name}")
    try:
        raw = load_document(p, max_pages=max_pages if p.suffix.lower() == ".pdf" else None)
        parts = chunk_text(raw, max_chunks=max_chunks)
        if not parts:
            return IngestReport(inserted=0, files=[f"{p.name} (sin texto)"])
        vectors = embed_texts(parts)
        ids = [str(uuid.uuid4())[:8] for _ in parts]
        entities = [ids, vectors, parts]
        collection.insert(entities)
        collection.flush()
        return IngestReport(inserted=len(ids), files=[p.name])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ingest error {p.name}: {e}")

class ChatQuery(BaseModel):
    question: str

@app.post("/chat")
def chat(q: ChatQuery):
    # Embedding de la pregunta
    qvec = embed_texts([q.question])[0]

    # Búsqueda vectorial
    search_params = {"metric_type": "IP", "params": {"nprobe": 16}}
    hits = collection.search(
        data=[qvec],
        anns_field="vector",
        param=search_params,
        limit=TOP_K,
        output_fields=["text"]
    )
    ctx = ""
    used = 0
    if hits and len(hits[0]) > 0:
        ctx = "\n\n".join([h.entity.get("text") for h in hits[0]])
        used = len(hits[0])

    prompt = (
        "Usa estrictamente el contexto para responder. "
        "Si el contexto no contiene la respuesta, indica claramente que no está en los documentos.\n\n"
        f"[Contexto]\n{ctx}\n\n[Pregunta]\n{q.question}\n\nRespuesta:"
    )

    payload = {
        "model": GEN_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False
    }

    attempts = 0
    while True:
        try:
            r = requests.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=600)
            r.raise_for_status()
            data = r.json()
            answer = (data.get("message", {}) or {}).get("content") or data.get("response", "")
            if not answer:
                raise HTTPException(status_code=503, detail="Ollama no devolvió contenido.")
            return {"answer": answer, "used_docs": used}
        except (ReadTimeout, RequestException) as e:
            attempts += 1
            if attempts >= 2:
                raise HTTPException(status_code=503, detail=f"Ollama chat error: {e}")
            time.sleep(4 * attempts)  # backoff
