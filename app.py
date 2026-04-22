import os
import sys
import re
import uuid
import asyncio
import glob
import time
import threading
import secrets
import queue as qmod
import io
from datetime import datetime, timezone
from flask import Flask, render_template, request, jsonify, Response, stream_with_context
from pymongo import MongoClient, DESCENDING
from bson import ObjectId
from bson.errors import InvalidId

# Windows asyncio fix (required for edge-tts)
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import edge_tts

try:
    from mutagen.mp3 import MP3
    HAS_MUTAGEN = True
except ImportError:
    HAS_MUTAGEN = False

# ── App ───────────────────────────────────────────────────────────────────────
app = Flask(__name__)

GENERATED_DIR = os.path.join(app.static_folder, "generated")
os.makedirs(GENERATED_DIR, exist_ok=True)

FILE_EXPIRY_SECONDS = 7 * 24 * 3600  # keep files 7 days
CHUNK_SIZE = 1500

# Streaming token store: token → params (expires in 5 min)
_stream_tokens: dict = {}
_tokens_lock = threading.Lock()

# ── MongoDB ───────────────────────────────────────────────────────────────────
MONGO_URI = os.environ.get(
    "MONGO_URI",
    "mongodb+srv://ssnn01:xenlulozo1@nhanapp-cluster.yfdohhl.mongodb.net/?appName=nhanapp-cluster",
)
_mongo_client = None
_mongo_lock = threading.Lock()


def get_db():
    global _mongo_client
    with _mongo_lock:
        if _mongo_client is None:
            _mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=8000)
    return _mongo_client["tts_studio"]


def col_history():
    return get_db()["audio_history"]


def col_progress():
    return get_db()["audio_listening_progress"]


# ── Fallback voices (used when Microsoft API is unavailable) ──────────────────
FALLBACK_VOICES = [
    {"name":"vi-VN-HoaiMyNeural",   "display":"Microsoft Hoai My Online (Natural) - Vietnamese (Vietnam)",   "locale":"vi-VN","gender":"Female"},
    {"name":"vi-VN-NamMinhNeural",  "display":"Microsoft Nam Minh Online (Natural) - Vietnamese (Vietnam)",  "locale":"vi-VN","gender":"Male"},
    {"name":"en-US-JennyNeural",    "display":"Microsoft Jenny Online (Natural) - English (United States)",  "locale":"en-US","gender":"Female"},
    {"name":"en-US-GuyNeural",      "display":"Microsoft Guy Online (Natural) - English (United States)",    "locale":"en-US","gender":"Male"},
    {"name":"en-US-AriaNeural",     "display":"Microsoft Aria Online (Natural) - English (United States)",   "locale":"en-US","gender":"Female"},
    {"name":"en-US-DavisNeural",    "display":"Microsoft Davis Online (Natural) - English (United States)",  "locale":"en-US","gender":"Male"},
    {"name":"en-GB-SoniaNeural",    "display":"Microsoft Sonia Online (Natural) - English (United Kingdom)", "locale":"en-GB","gender":"Female"},
    {"name":"en-GB-RyanNeural",     "display":"Microsoft Ryan Online (Natural) - English (United Kingdom)",  "locale":"en-GB","gender":"Male"},
    {"name":"zh-CN-XiaoxiaoNeural", "display":"Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)",   "locale":"zh-CN","gender":"Female"},
    {"name":"zh-CN-YunxiNeural",    "display":"Microsoft Yunxi Online (Natural) - Chinese (Mainland)",      "locale":"zh-CN","gender":"Male"},
    {"name":"ja-JP-NanamiNeural",   "display":"Microsoft Nanami Online (Natural) - Japanese (Japan)",       "locale":"ja-JP","gender":"Female"},
    {"name":"ja-JP-KeitaNeural",    "display":"Microsoft Keita Online (Natural) - Japanese (Japan)",        "locale":"ja-JP","gender":"Male"},
    {"name":"ko-KR-SunHiNeural",    "display":"Microsoft Sun-Hi Online (Natural) - Korean (Korea)",         "locale":"ko-KR","gender":"Female"},
    {"name":"ko-KR-InJoonNeural",   "display":"Microsoft InJoon Online (Natural) - Korean (Korea)",         "locale":"ko-KR","gender":"Male"},
    {"name":"fr-FR-DeniseNeural",   "display":"Microsoft Denise Online (Natural) - French (France)",        "locale":"fr-FR","gender":"Female"},
    {"name":"de-DE-KatjaNeural",    "display":"Microsoft Katja Online (Natural) - German (Germany)",        "locale":"de-DE","gender":"Female"},
    {"name":"es-ES-ElviraNeural",   "display":"Microsoft Elvira Online (Natural) - Spanish (Spain)",        "locale":"es-ES","gender":"Female"},
    {"name":"pt-BR-FranciscaNeural","display":"Microsoft Francisca Online (Natural) - Portuguese (Brazil)", "locale":"pt-BR","gender":"Female"},
    {"name":"th-TH-PremwadeeNeural","display":"Microsoft Premwadee Online (Natural) - Thai (Thailand)",     "locale":"th-TH","gender":"Female"},
    {"name":"id-ID-GadisNeural",    "display":"Microsoft Gadis Online (Natural) - Indonesian (Indonesia)",  "locale":"id-ID","gender":"Female"},
]

# ── Voice cache ───────────────────────────────────────────────────────────────
_voices_cache = None
_voices_lock = threading.Lock()


async def _fetch_voices_with_retry(retries: int = 3) -> list:
    last_err = None
    for attempt in range(retries):
        try:
            raw = await edge_tts.list_voices()
            return sorted(
                [{"name": v["ShortName"], "display": v["FriendlyName"],
                  "locale": v["Locale"],  "gender": v["Gender"]} for v in raw],
                key=lambda v: (v["locale"], v["name"]),
            )
        except Exception as e:
            last_err = e
            if attempt < retries - 1:
                await asyncio.sleep(1.5)
    raise last_err


def get_voices():
    global _voices_cache
    with _voices_lock:
        if _voices_cache is None:
            try:
                _voices_cache = asyncio.run(_fetch_voices_with_retry())
            except Exception:
                # Microsoft API unavailable — use built-in fallback list
                _voices_cache = FALLBACK_VOICES
    return _voices_cache


def find_voice_display(voice_code: str) -> str:
    for v in get_voices():
        if v["name"] == voice_code:
            return v["display"]
    return voice_code


# ── Text chunking ─────────────────────────────────────────────────────────────
def split_text(text: str, max_chunk: int = CHUNK_SIZE) -> list:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    paragraphs = re.split(r"\n{2,}", text)
    chunks, current = [], ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(current) + len(para) + 2 <= max_chunk:
            current = (current + "\n\n" + para).lstrip("\n")
        else:
            if current:
                chunks.append(current.strip())
                current = ""
            if len(para) <= max_chunk:
                current = para
            else:
                sentences = re.split(r"(?<=[.!?。！？;；])\s+", para)
                for sent in sentences:
                    sent = sent.strip()
                    if not sent:
                        continue
                    if len(current) + len(sent) + 1 <= max_chunk:
                        current = (current + " " + sent).strip()
                    else:
                        if current:
                            chunks.append(current.strip())
                        if len(sent) > max_chunk:
                            for i in range(0, len(sent), max_chunk):
                                chunks.append(sent[i: i + max_chunk])
                            current = ""
                        else:
                            current = sent

    if current.strip():
        chunks.append(current.strip())
    return chunks if chunks else [text]


# ── TTS synthesis (all chunks in parallel) ────────────────────────────────────
async def synthesize_chunks(chunks: list, voice: str, rate: str, volume: str) -> bytes:
    async def synth_one(chunk_text: str) -> bytes:
        data = b""
        communicate = edge_tts.Communicate(chunk_text, voice, rate=rate, volume=volume)
        async for item in communicate.stream():
            if item["type"] == "audio":
                data += item["data"]
        return data

    results = await asyncio.gather(*[synth_one(c) for c in chunks])
    return b"".join(results)


# ── Helpers ───────────────────────────────────────────────────────────────────
def cleanup_old_files():
    now = time.time()
    for filepath in glob.glob(os.path.join(GENERATED_DIR, "*.mp3")):
        try:
            if now - os.path.getmtime(filepath) > FILE_EXPIRY_SECONDS:
                os.remove(filepath)
        except OSError:
            pass


def get_duration(filepath: str) -> float:
    if HAS_MUTAGEN:
        try:
            return round(MP3(filepath).info.length, 2)
        except Exception:
            pass
    return 0.0


def format_rate(value: int) -> str:
    return f"+{value}%" if value >= 0 else f"{value}%"


def serialize_doc(doc: dict) -> dict:
    result = {}
    for k, v in doc.items():
        if isinstance(v, ObjectId):
            result[k] = str(v)
        elif isinstance(v, datetime):
            result[k] = v.isoformat()
        else:
            result[k] = v
    return result


# ── Routes ────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/voices")
def api_voices():
    try:
        v = get_voices()
        is_fallback = (v is FALLBACK_VOICES)
        return jsonify({"voices": v, "fallback": is_fallback})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/generate", methods=["POST"])
def api_generate():
    cleanup_old_files()

    data   = request.get_json(silent=True) or {}
    text   = (data.get("text") or "").strip()
    voice  = data.get("voice", "vi-VN-HoaiMyNeural")
    rate   = format_rate(int(data.get("rate", 0)))
    volume = format_rate(int(data.get("volume", 0)))

    if not text:
        return jsonify({"error": "Vui lòng nhập văn bản."}), 400
    if not voice:
        return jsonify({"error": "Vui lòng chọn giọng đọc."}), 400

    chunks   = split_text(text, CHUNK_SIZE)
    filename = f"{uuid.uuid4().hex}.mp3"
    filepath = os.path.join(GENERATED_DIR, filename)
    now      = datetime.now(timezone.utc)
    voice_display = find_voice_display(voice)
    lang_code     = "-".join(voice.split("-")[:2])

    # Save "processing" record to MongoDB
    doc = {
        "user_id":           "personal",
        "title":             text[:80] + ("…" if len(text) > 80 else ""),
        "original_text":     text,
        "normalized_text":   text,
        "language_code":     lang_code,
        "voice_code":        voice,
        "voice_name":        voice_display,
        "speed_rate":        rate,
        "pitch_rate":        "+0%",
        "volume_rate":       volume,
        "character_count":   len(text),
        "duration_seconds":  0,
        "file_name":         filename,
        "file_url":          f"/static/generated/{filename}",
        "file_size_bytes":   0,
        "audio_format":      "mp3",
        "status":            "processing",
        "error_message":     None,
        "created_at":        now,
        "updated_at":        now,
        "deleted_at":        None,
    }
    history_id = None
    try:
        history_id = str(col_history().insert_one(doc).inserted_id)
    except Exception:
        pass  # DB unavailable — still generate audio

    # Synthesize (parallel chunks)
    try:
        audio_bytes = asyncio.run(synthesize_chunks(chunks, voice, rate, volume))
        with open(filepath, "wb") as f:
            f.write(audio_bytes)
    except Exception as exc:
        if history_id:
            col_history().update_one(
                {"_id": ObjectId(history_id)},
                {"$set": {"status": "failed", "error_message": str(exc),
                          "updated_at": datetime.now(timezone.utc)}},
            )
        return jsonify({"error": f"Lỗi tạo giọng nói: {exc}"}), 500

    duration  = get_duration(filepath)
    file_size = os.path.getsize(filepath)

    if history_id:
        col_history().update_one(
            {"_id": ObjectId(history_id)},
            {"$set": {
                "status":           "completed",
                "duration_seconds": duration,
                "file_size_bytes":  file_size,
                "updated_at":       datetime.now(timezone.utc),
            }},
        )

    return jsonify({
        "audio_url":        f"/static/generated/{filename}",
        "filename":         filename,
        "history_id":       history_id,
        "chunks":           len(chunks),
        "chars":            len(text),
        "duration_seconds": duration,
    })


@app.route("/api/prepare", methods=["POST"])
def api_prepare():
    """Reserve a streaming token. Returns token + stream URL immediately (<50 ms)."""
    cleanup_old_files()
    data   = request.get_json(silent=True) or {}
    text   = (data.get("text") or "").strip()
    voice  = data.get("voice", "vi-VN-HoaiMyNeural")
    rate   = int(data.get("rate", 0))
    volume = int(data.get("volume", 0))

    if not text:
        return jsonify({"error": "Vui lòng nhập văn bản."}), 400
    if not voice:
        return jsonify({"error": "Vui lòng chọn giọng đọc."}), 400

    # Pre-assign filename so frontend knows the eventual download URL
    filename = f"{uuid.uuid4().hex}.mp3"
    token    = secrets.token_urlsafe(20)

    with _tokens_lock:
        # Evict tokens older than 5 min
        now_ts = time.time()
        stale  = [k for k, v in _stream_tokens.items() if now_ts - v["ts"] > 300]
        for k in stale:
            del _stream_tokens[k]

        _stream_tokens[token] = {
            "text": text, "voice": voice, "rate": rate, "volume": volume,
            "filename": filename, "ts": time.time(),
        }

    return jsonify({
        "token":      token,
        "stream_url": f"/api/stream/{token}",
        "file_url":   f"/static/generated/{filename}",
        "chars":      len(text),
    })


@app.route("/api/stream/<token>")
def api_stream(token):
    """Stream MP3 audio bytes as they're generated; save file + history in background."""
    with _tokens_lock:
        params = _stream_tokens.pop(token, None)

    if not params:
        return "Token không hợp lệ hoặc đã hết hạn.", 404

    text     = params["text"]
    voice    = params["voice"]
    rate_str = format_rate(params["rate"])
    vol_str  = format_rate(params["volume"])
    filename = params["filename"]
    filepath = os.path.join(GENERATED_DIR, filename)
    file_url = f"/static/generated/{filename}"
    chunks   = split_text(text, CHUNK_SIZE)

    audio_q = qmod.Queue()  # producer → consumer (Flask response)

    async def produce():
        buf = io.BytesIO()
        try:
            for chunk_text in chunks:
                for attempt in range(3):
                    try:
                        comm = edge_tts.Communicate(chunk_text, voice, rate=rate_str, volume=vol_str)
                        async for item in comm.stream():
                            if item["type"] == "audio":
                                buf.write(item["data"])
                                audio_q.put(item["data"])
                        break  # chunk done, move on
                    except Exception as exc:
                        print(f"[stream] chunk attempt {attempt+1} failed: {exc}")
                        if attempt < 2:
                            await asyncio.sleep(1.5)
        except Exception as exc:
            print(f"[stream] synthesis error: {exc}")
        finally:
            audio_q.put(None)           # signal end
            _save_after_stream(buf, filepath, file_url, filename, text, voice, rate_str, vol_str)

    threading.Thread(target=lambda: asyncio.run(produce()), daemon=True).start()

    def generate():
        while True:
            try:
                chunk = audio_q.get(timeout=60)
            except qmod.Empty:
                break
            if chunk is None:
                break
            yield chunk

    resp = Response(stream_with_context(generate()), mimetype="audio/mpeg")
    resp.headers["Cache-Control"]     = "no-cache, no-store"
    resp.headers["X-Accel-Buffering"] = "no"   # disable nginx proxy buffering
    return resp


def _save_after_stream(buf: io.BytesIO, filepath, file_url, filename, text, voice, rate_str, vol_str):
    """Write MP3 to disk and upsert MongoDB record (runs in background thread)."""
    try:
        audio_bytes = buf.getvalue()
        if not audio_bytes:
            return
        with open(filepath, "wb") as f:
            f.write(audio_bytes)

        duration   = get_duration(filepath)
        file_size  = len(audio_bytes)
        now        = datetime.now(timezone.utc)
        voice_disp = find_voice_display(voice)
        lang_code  = "-".join(voice.split("-")[:2])

        doc = {
            "user_id":          "personal",
            "title":            text[:80] + ("…" if len(text) > 80 else ""),
            "original_text":    text,
            "normalized_text":  text,
            "language_code":    lang_code,
            "voice_code":       voice,
            "voice_name":       voice_disp,
            "speed_rate":       rate_str,
            "pitch_rate":       "+0%",
            "volume_rate":      vol_str,
            "character_count":  len(text),
            "duration_seconds": duration,
            "file_name":        filename,
            "file_url":         file_url,
            "file_size_bytes":  file_size,
            "audio_format":     "mp3",
            "status":           "completed",
            "error_message":    None,
            "created_at":       now,
            "updated_at":       now,
            "deleted_at":       None,
        }
        col_history().insert_one(doc)
    except Exception as exc:
        print(f"[stream] save error: {exc}")


@app.route("/api/history")
def api_history():
    try:
        skip  = int(request.args.get("skip", 0))
        limit = int(request.args.get("limit", 30))
        query = {"deleted_at": None, "user_id": "personal"}

        docs  = list(col_history().find(query, sort=[("created_at", DESCENDING)],
                                        skip=skip, limit=limit))
        total = col_history().count_documents(query)

        # Check if file still exists on disk
        for doc in docs:
            fp = os.path.join(GENERATED_DIR, doc.get("file_name", ""))
            doc["file_available"] = os.path.exists(fp)

        return jsonify({"items": [serialize_doc(d) for d in docs], "total": total})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/history/<history_id>", methods=["DELETE"])
def api_history_delete(history_id: str):
    try:
        result = col_history().update_one(
            {"_id": ObjectId(history_id)},
            {"$set": {"deleted_at": datetime.now(timezone.utc)}},
        )
        if result.matched_count == 0:
            return jsonify({"error": "Không tìm thấy."}), 404
        return jsonify({"ok": True})
    except (InvalidId, Exception) as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/progress/<history_id>", methods=["GET"])
def api_progress_get(history_id: str):
    try:
        doc = col_progress().find_one({"audio_history_id": history_id, "user_id": "personal"})
        return jsonify(serialize_doc(doc) if doc else {})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/progress/<history_id>", methods=["PUT"])
def api_progress_update(history_id: str):
    try:
        data      = request.get_json(silent=True) or {}
        now       = datetime.now(timezone.utc)
        position  = float(data.get("last_position_seconds", 0))
        listened  = float(data.get("total_listened_seconds", 0))
        count     = int(data.get("listen_count", 1))
        completed = bool(data.get("is_completed", False))

        update = {
            "last_position_seconds":  position,
            "total_listened_seconds": listened,
            "listen_count":           count,
            "is_completed":           completed,
            "last_listened_at":       now,
            "updated_at":             now,
        }
        if completed:
            update["completed_at"] = now

        col_progress().update_one(
            {"audio_history_id": history_id, "user_id": "personal"},
            {
                "$set": update,
                "$setOnInsert": {
                    "audio_history_id": history_id,
                    "user_id":          "personal",
                    "created_at":       now,
                },
            },
            upsert=True,
        )
        return jsonify({"ok": True})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port  = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("RENDER") is None
    print(f"TTS Studio đang chạy tại: http://127.0.0.1:{port}")
    app.run(debug=debug, port=port, host="0.0.0.0")
