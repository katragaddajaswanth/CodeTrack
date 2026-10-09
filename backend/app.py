import os
import json
import re
import secrets
import sqlite3
import smtplib
import time
from email.message import EmailMessage
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from functools import wraps
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, session
from flask_cors import CORS
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__)
SECRET_FILE = Path(__file__).with_name(".codetrack-secret")
if os.environ.get("CODETRACK_SECRET_KEY"):
    persistent_secret = os.environ["CODETRACK_SECRET_KEY"]
else:
    if not SECRET_FILE.exists():
        SECRET_FILE.write_text(secrets.token_hex(32), encoding="utf-8")
    persistent_secret = SECRET_FILE.read_text(encoding="utf-8").strip()
app.config.update(
    SECRET_KEY=persistent_secret,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
)
frontend_origins_raw = os.environ.get(
    "CODETRACK_FRONTEND_ORIGIN",
    "http://localhost:5500,http://127.0.0.1:5500,http://localhost:5501,http://127.0.0.1:5501,http://localhost:3000,http://127.0.0.1:3000,http://localhost:8000,http://127.0.0.1:8000,http://localhost:5173,http://127.0.0.1:5173",
).split(",")
frontend_origins = [o.strip() for o in frontend_origins_raw if o.strip()]
frontend_origins.append(re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"))
CORS(app, supports_credentials=True, origins=frontend_origins)

DATABASE = Path(__file__).with_name("codetrack.db")
LEETCODE_CACHE_TTL = int(os.environ.get("CODETRACK_LEETCODE_CACHE_TTL", "900"))
LEETCODE_API = "https://alfa-leetcode-api.onrender.com"
FRONTEND_URL = os.environ.get("CODETRACK_FRONTEND_URL", "http://localhost:5500")


def connection():
    database = sqlite3.connect(DATABASE)
    database.row_factory = sqlite3.Row
    return database


def init_database():
    with connection() as database:
        database.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)
        database.execute("""
            CREATE TABLE IF NOT EXISTS leetcode_cache (
                user_id INTEGER PRIMARY KEY,
                username TEXT NOT NULL,
                payload TEXT NOT NULL,
                synced_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
        database.execute("""
            CREATE TABLE IF NOT EXISTS password_resets (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)


def current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    with connection() as database:
        return database.execute(
            "SELECT id, email, name, created_at FROM users WHERE id = ?", (user_id,)
        ).fetchone()


def login_required(handler):
    @wraps(handler)
    def protected_handler(*args, **kwargs):
        if current_user() is None:
            return jsonify(error="Authentication required."), 401
        return handler(*args, **kwargs)

    return protected_handler


def fetch_json(url):
    request = Request(url, headers={"User-Agent": "CODETRACK/1.0"})
    with urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def post_json(url, payload):
        body = json.dumps(payload).encode("utf-8")
        request = Request(url, data=body, headers={"User-Agent": "CODETRACK/1.0", "Content-Type": "application/json"})
        with urlopen(request, timeout=20) as response:
                return json.loads(response.read().decode("utf-8"))


def fetch_graphql_profile(username):
        query = """
        query userProfile($username: String!) {
            matchedUser(username: $username) {
                username
                submissionCalendar
                submitStats {
                    acSubmissionNum { difficulty count submissions }
                    totalSubmissionNum { difficulty count submissions }
                }
                languageProblemCount { languageName problemsSolved }
            }
        }
        """
        result = post_json("https://leetcode.com/graphql", {"query": query, "variables": {"username": username}})
        matched_user = (result.get("data") or {}).get("matchedUser")
        if not matched_user:
                raise ValueError("LeetCode user was not found.")
        accepted = {item["difficulty"]: item["count"] for item in matched_user["submitStats"]["acSubmissionNum"]}
        totals = {item["difficulty"]: item["submissions"] for item in matched_user["submitStats"]["totalSubmissionNum"]}
        return {
                "totalSolved": accepted.get("All", 0),
                "easySolved": accepted.get("Easy", 0),
                "mediumSolved": accepted.get("Medium", 0),
                "hardSolved": accepted.get("Hard", 0),
                "totalSubmissions": [{"difficulty": key, "submissions": value} for key, value in totals.items()],
                "submissionCalendar": matched_user.get("submissionCalendar", "{}"),
                "languageProblemCount": matched_user.get("languageProblemCount", []),
        }


def fetch_graphql_submissions(username, limit=15):
    query = """
    query recentAcSubmissions($username: String!, $limit: Int!) {
        recentAcSubmissionList(username: $username, limit: $limit) {
            id
            title
            titleSlug
            timestamp
        }
    }
    """
    result = post_json("https://leetcode.com/graphql", {"query": query, "variables": {"username": username, "limit": limit}})
    return (result.get("data") or {}).get("recentAcSubmissionList") or []


def leetcode_username(value):
    value = str(value or "").strip().rstrip("/")
    if "/" in value:
        value = value.split("/")[-1]
    return value.lstrip("@")


@app.post("/api/auth/signup")
def signup():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))

    if len(name) < 1 or len(name) > 60:
        return jsonify(error="Enter a name between 1 and 60 characters."), 400
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return jsonify(error="Enter a valid email address."), 400
    if len(password) < 6:
        return jsonify(error="Password must be at least 6 characters."), 400

    try:
        with connection() as database:
            cursor = database.execute(
                "INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)",
                (email, name, generate_password_hash(password)),
            )
            session["user_id"] = cursor.lastrowid
    except sqlite3.IntegrityError:
        return jsonify(error="An account with this email already exists."), 409

    return jsonify(user={"email": email, "name": name}), 201


@app.post("/api/auth/login")
def login():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))

    with connection() as database:
        user = database.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()

    if user is None or not check_password_hash(user["password_hash"], password):
        return jsonify(error="Email or password is incorrect."), 401

    session["user_id"] = user["id"]
    return jsonify(user={"email": user["email"], "name": user["name"]})


@app.post("/api/auth/forgot-password")
def forgot_password():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return jsonify(error="Enter a valid email address."), 400
    with connection() as database:
        user = database.execute("SELECT id, email FROM users WHERE email = ?", (email,)).fetchone()
    if user:
        token = secrets.token_urlsafe(32)
        expires_at = int(time.time()) + 3600
        with connection() as database:
            database.execute("DELETE FROM password_resets WHERE user_id = ?", (user["id"],))
            database.execute("INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)", (token, user["id"], expires_at))
        smtp_host = os.environ.get("CODETRACK_SMTP_HOST")
        smtp_user = os.environ.get("CODETRACK_SMTP_USER")
        smtp_password = os.environ.get("CODETRACK_SMTP_PASSWORD")
        smtp_port = int(os.environ.get("CODETRACK_SMTP_PORT", "587"))
        reset_link = f"{FRONTEND_URL}/?reset={token}"
        if smtp_host and smtp_user and smtp_password:
            try:
                message = EmailMessage()
                message["Subject"] = "Reset your CODETRACK password"
                message["From"] = smtp_user
                message["To"] = email
                message.set_content(f"Reset your password within one hour: {reset_link}")
                with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as smtp:
                    smtp.starttls()
                    smtp.login(smtp_user, smtp_password)
                    smtp.send_message(message)
            except Exception as mail_err:
                print(f"[CODETRACK] SMTP send failed: {mail_err}. Reset link: {reset_link}")
        else:
            print(f"[CODETRACK DEV] Password reset link for {email}: {reset_link}")
    return jsonify(message="If an account exists, password-reset instructions will be sent.")


@app.post("/api/auth/reset-password")
def reset_password():
    data = request.get_json(silent=True) or {}
    token = str(data.get("token", ""))
    password = str(data.get("password", ""))
    if len(password) < 6:
        return jsonify(error="Password must be at least 6 characters."), 400
    with connection() as database:
        reset = database.execute("SELECT user_id, expires_at FROM password_resets WHERE token = ?", (token,)).fetchone()
        if not reset or reset["expires_at"] < int(time.time()):
            return jsonify(error="This reset link is invalid or expired."), 400
        database.execute("UPDATE users SET password_hash = ? WHERE id = ?", (generate_password_hash(password), reset["user_id"]))
        database.execute("DELETE FROM password_resets WHERE token = ?", (token,))
    return jsonify(message="Password updated. You can sign in now.")


@app.get("/api/auth/me")
@login_required
def me():
    user = current_user()
    return jsonify(user={"email": user["email"], "name": user["name"]})


@app.put("/api/auth/account")
@login_required
def update_account():
    data = request.get_json(silent=True) or {}
    user = current_user()
    current_password = str(data.get("currentPassword", ""))
    new_email = str(data.get("email", user["email"])).strip().lower()
    new_password = str(data.get("newPassword", ""))

    with connection() as database:
        stored_user = database.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
        if (new_email != user["email"] or new_password) and not check_password_hash(stored_user["password_hash"], current_password):
            return jsonify(error="Current password is required for account changes."), 400
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", new_email):
            return jsonify(error="Enter a valid email address."), 400
        if new_password and len(new_password) < 6:
            return jsonify(error="New password must be at least 6 characters."), 400
        try:
            database.execute(
                "UPDATE users SET email = ?, password_hash = COALESCE(?, password_hash) WHERE id = ?",
                (new_email, generate_password_hash(new_password) if new_password else None, user["id"]),
            )
        except sqlite3.IntegrityError:
            return jsonify(error="That email is already in use."), 409

    session["user_id"] = user["id"]
    return jsonify(user={"email": new_email, "name": user["name"]})


@app.post("/api/auth/logout")
def logout():
    session.clear()
    return jsonify(message="Logged out.")


@app.get("/api/leetcode/sync")
def leetcode_sync():
    user = current_user()
    username = leetcode_username(request.args.get("username"))
    if not username or username.lower() == "leetcode.com":
        return jsonify(error="A valid LeetCode username or profile URL is required."), 400

    now = int(time.time())
    cached_payload = None
    if user:
        with connection() as database:
            cached = database.execute(
                "SELECT username, payload, synced_at FROM leetcode_cache WHERE user_id = ?",
                (user["id"],),
            ).fetchone()
        if cached:
            cached_payload = json.loads(cached["payload"])
            cache_is_current = cached_payload and "languageProblemCount" in cached_payload.get("profile", {})
            if cache_is_current and cached["username"].lower() == username.lower() and now - cached["synced_at"] < LEETCODE_CACHE_TTL:
                return jsonify(**cached_payload, lastSynced=cached["synced_at"], cached=True)

    try:
        profile = None
        # Try alfa-leetcode-api first
        try:
            raw_profile = fetch_json(f"{LEETCODE_API}/userProfile/{quote(username)}")
            if raw_profile and not raw_profile.get("errors") and (raw_profile.get("totalSolved") is not None or "totalSolved" in raw_profile):
                profile = raw_profile
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, Exception):
            pass

        # Fallback to direct LeetCode GraphQL
        if profile is None:
            profile = fetch_graphql_profile(username)

        if "languageProblemCount" not in profile or not profile.get("languageProblemCount"):
            try:
                graphql_profile = fetch_graphql_profile(username)
                profile["languageProblemCount"] = graphql_profile.get("languageProblemCount", [])
                profile.setdefault("submissionCalendar", graphql_profile.get("submissionCalendar", "{}"))
            except Exception:
                profile.setdefault("languageProblemCount", [])
                profile.setdefault("submissionCalendar", "{}")

        submissions = []
        submissions_unavailable = False
        try:
            raw_submissions = fetch_json(f"{LEETCODE_API}/recentSubmissions/{quote(username)}")
            if isinstance(raw_submissions, list) and raw_submissions:
                submissions = raw_submissions
            elif isinstance(raw_submissions, dict) and "recentSubmissions" in raw_submissions and raw_submissions["recentSubmissions"]:
                submissions = raw_submissions["recentSubmissions"]
            else:
                submissions = []
        except Exception:
            submissions = []

        # If Alfa API recentSubmissions was empty or 404, fall back to official LeetCode GraphQL
        if not submissions:
            try:
                gql_submissions = fetch_graphql_submissions(username)
                if gql_submissions:
                    submissions = [
                        {
                            "id": item.get("id"),
                            "title": item.get("title", "LeetCode submission"),
                            "titleSlug": item.get("titleSlug", ""),
                            "timestamp": item.get("timestamp"),
                            "statusDisplay": "Accepted",
                            "lang": "LeetCode",
                        }
                        for item in gql_submissions
                    ]
            except Exception:
                pass

        if not submissions:
            submissions_unavailable = True

        payload = {"profile": profile, "submissions": submissions, "submissionsUnavailable": submissions_unavailable}
        if user:
            with connection() as database:
                database.execute(
                    "INSERT INTO leetcode_cache (user_id, username, payload, synced_at) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, payload=excluded.payload, synced_at=excluded.synced_at",
                    (user["id"], username, json.dumps(payload), now),
                )
        return jsonify(**payload, lastSynced=now, cached=False)
    except ValueError as error:
        return jsonify(error=str(error)), 404
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, Exception) as error:
        if cached_payload:
            return jsonify(**cached_payload, lastSynced=cached["synced_at"], cached=True, stale=True)
        status = getattr(error, "code", 502)
        return jsonify(error="LeetCode is temporarily unavailable and no cached sync exists."), status if isinstance(status, int) and status >= 400 else 502


FRONTEND_DIR = Path(__file__).resolve().parent.parent


@app.get("/api/health")
def health():
    return jsonify(status="online", service="CODETRACK authentication")


@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/styles.css")
def styles():
    return send_from_directory(FRONTEND_DIR, "styles.css")


@app.get("/script.js")
def script():
    return send_from_directory(FRONTEND_DIR, "script.js")


init_database()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=True)
