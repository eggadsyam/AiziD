"""
app.py — Aplikasi utama Google Drive Aggregator.
Flask web server dengan OAuth 2.0, API endpoints, dashboard, dan sinkronisasi caching database.
"""

import os
import io
import threading
import re
from flask import (
    Flask, redirect, url_for, session, request,
    render_template, jsonify, send_file, Response
)
from flask_jwt_extended import JWTManager, create_access_token, jwt_required, get_jwt_identity, verify_jwt_in_request
from werkzeug.security import generate_password_hash, check_password_hash
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

from models import SessionLocal, Account, FileCache, User, init_db
from drive_service import (
    get_storage_quota, list_files,
    delete_file as drive_delete,
    rename_file as drive_rename,
    download_file as drive_download,
    create_folder as drive_create_folder,
    upload_file as drive_upload_file,
    toggle_starred as drive_toggle_starred,
    toggle_shared as drive_toggle_shared
)
from aggregator import (
    get_total_quota, get_merged_files, smart_upload,
    sync_all_accounts_cache, detect_duplicate_files, merge_gpart_files
)

# ============================================================
# App Configuration
# ============================================================
import sys

def get_resource_path(relative_path):
    """Dapatkan path absolut untuk resource, kompatibel dengan PyInstaller _internal folder."""
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, relative_path)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), relative_path)

app = Flask(
    __name__,
    template_folder=get_resource_path('templates'),
    static_folder=get_resource_path('static')
)
app.secret_key = 'gabungin-drive-aggregator-secret-key-2024'
app.config['JWT_SECRET_KEY'] = os.getenv('JWT_SECRET_KEY', 'super-secret-jwt-key')
jwt = JWTManager(app)

active_uploads_progress = {}

# Izinkan OAuth berjalan di HTTP (hanya untuk development lokal)
os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'

CLIENT_SECRETS_FILE = get_resource_path("client_secret_371845009482-fktit3komkb5p6ok8t397fg6rqjfvr4k.apps.googleusercontent.com.json")
SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'openid'
]

# Inisialisasi database
init_db()


# ============================================================
# Background Sync Helpers
# ============================================================
def run_background_sync(user_id=None):
    """Menjalankan sinkronisasi metadata secara asynchronous di background thread."""
    db = SessionLocal()
    try:
        query = db.query(Account)
        if user_id:
            query = query.filter_by(user_id=user_id)
        accounts = query.all()
        if accounts:
            print(f"Pemicu background sync dimulai untuk user {user_id}...")
            sync_all_accounts_cache(db, accounts)
            print(f"Background sync selesai untuk user {user_id}.")
    except Exception as e:
        print(f"Background sync error: {e}")
    finally:
        db.close()


def start_background_sync(user_id=None):
    """Mulai thread baru untuk sinkronisasi latar belakang."""
    thread = threading.Thread(target=run_background_sync, args=(user_id,))
    thread.daemon = True
    thread.start()


# ============================================================
# Routes — Halaman & OAuth
# ============================================================

@app.before_request
def require_login():
    # Selalu asumsikan user lokal id 1 untuk versi standalone desktop
    request.user_id = 1
    session['user_id'] = 1
    session['username'] = 'Local User'


@app.route('/')
def index():
    """Dashboard utama."""
    user_id = getattr(request, 'user_id', None)
    # Picu sinkronisasi awal saat user membuka dashboard untuk user tersebut
    start_background_sync(user_id=user_id)
    return render_template('dashboard.html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    """Halaman masuk (login) pengguna. Di-redirect ke dashboard untuk versi standalone."""
    return redirect(url_for('index'))


@app.route('/register', methods=['POST'])
def register():
    """Halaman registrasi pengguna baru. Di-redirect ke dashboard untuk versi standalone."""
    return redirect(url_for('index'))


@app.route('/logout')
def logout():
    """Keluar dari aplikasi dan membersihkan sesi. Di-redirect ke dashboard untuk versi standalone."""
    return redirect(url_for('index'))


@app.route('/add_account')
def add_account():
    """Mulai OAuth flow untuk menambahkan akun Google Drive baru."""
    flow = Flow.from_client_secrets_file(
        CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri=url_for('oauth2callback', _external=True)
    )
    authorization_url, state = flow.authorization_url(
        access_type='offline',
        include_granted_scopes='true',
        prompt='consent'  # Memaksa Google mengeluarkan refresh_token setiap login
    )
    # Simpan state dan code_verifier (PKCE) di session
    session['state'] = state
    session['code_verifier'] = flow.code_verifier
    return redirect(authorization_url)


@app.route('/oauth2callback')
def oauth2callback():
    """Callback dari Google setelah user menyetujui akses."""
    state = session.get('state')
    code_verifier = session.get('code_verifier')

    flow = Flow.from_client_secrets_file(
        CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        state=state,
        redirect_uri=url_for('oauth2callback', _external=True)
    )
    # Restore PKCE code verifier agar tidak error "Missing code verifier"
    flow.code_verifier = code_verifier

    # Ambil token dari Google
    flow.fetch_token(authorization_response=request.url)

    credentials = flow.credentials

    # Ambil info user (email, nama) menggunakan OAuth2 API
    oauth2_service = build('oauth2', 'v2', credentials=credentials, cache_discovery=False)
    user_info = oauth2_service.userinfo().get().execute()

    # Simpan ke database
    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        existing = db.query(Account).filter_by(email=user_info.get('email'), user_id=user_id).first()
        if existing:
            # Update akun yang sudah ada
            existing.access_token = credentials.token
            if credentials.refresh_token:
                existing.refresh_token = credentials.refresh_token
            existing.token_uri = credentials.token_uri
            existing.client_id = credentials.client_id
            existing.client_secret = credentials.client_secret
            existing.display_name = user_info.get('name', '')
        else:
            # Buat akun baru
            account = Account(
                user_id=user_id,
                email=user_info.get('email'),
                display_name=user_info.get('name', ''),
                access_token=credentials.token,
                refresh_token=credentials.refresh_token,
                token_uri=credentials.token_uri,
                client_id=credentials.client_id,
                client_secret=credentials.client_secret
            )
            db.add(account)
        db.commit()
        
        # Jalankan sinkronisasi awal di background setelah akun sukses ditambahkan
        start_background_sync(user_id=user_id)
    finally:
        db.close()

    return redirect(url_for('index'))


# ============================================================
# API Endpoints
# ============================================================


@app.route('/api/auth/login', methods=['POST'])
def api_login():
    data = request.get_json() or {}
    username = data.get('username')
    password = data.get('password')
    
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(username=username).first()
        if user and check_password_hash(user.password_hash, password):
            access_token = create_access_token(identity=str(user.id))
            return jsonify({'access_token': access_token, 'username': user.username})
        return jsonify({'error': 'Invalid credentials'}), 401
    finally:
        db.close()

@app.route('/api/auth/register', methods=['POST'])
def api_register():
    data = request.get_json() or {}
    username = data.get('username', '').strip()
    password = data.get('password', '')
    
    if not username or len(password) < 4:
        return jsonify({'error': 'Invalid username or password'}), 400
        
    db = SessionLocal()
    try:
        existing = db.query(User).filter_by(username=username).first()
        if existing:
            return jsonify({'error': 'Username already exists'}), 400
            
        new_user = User(
            username=username,
            password_hash=generate_password_hash(password)
        )
        db.add(new_user)
        db.commit()
        return jsonify({'success': True, 'message': 'Registered successfully'})
    finally:
        db.close()

@app.route('/api/accounts')
def api_accounts():
    """Daftar semua akun yang terhubung."""
    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        accounts = db.query(Account).filter_by(user_id=user_id).all()
        return jsonify([a.to_dict() for a in accounts])
    finally:
        db.close()


@app.route('/api/accounts/<int:account_id>', methods=['DELETE'])
def api_delete_account(account_id):
    """Hapus akun dari aplikasi (tidak menghapus dari Google)."""
    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        account = db.query(Account).filter_by(id=account_id, user_id=user_id).first()
        if account:
            # Bersihkan cache file dari akun ini juga
            db.query(FileCache).filter_by(account_id=account.id, user_id=user_id).delete()
            db.delete(account)
            db.commit()
            start_background_sync(user_id=user_id)
            return jsonify({'success': True})
        return jsonify({'error': 'Akun tidak ditemukan'}), 404
    finally:
        db.close()


@app.route('/api/quota')
def api_quota():
    """Kuota penyimpanan gabungan dari semua akun."""
    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        accounts = db.query(Account).filter_by(user_id=user_id).all()
        if not accounts:
            return jsonify({'total': 0, 'used': 0, 'free': 0, 'accounts': []})
        result = get_total_quota(accounts)
        db.commit()  # Simpan update kuota ke database
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/files')
def api_files():
    """Daftar file — mengambil data dari cache SQLite lokal."""
    folder_id = request.args.get('folder_id', 'root')
    account_id = request.args.get('account_id')
    file_type = request.args.get('type')  # 'shared' atau 'starred'

    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        query = db.query(FileCache).filter_by(user_id=user_id)
        
        if file_type == 'starred':
            query = query.filter_by(is_starred=1)
        elif file_type == 'shared':
            query = query.filter_by(is_shared=1)
        else:
            query = query.filter_by(parent_id=folder_id)
            
        if account_id:
            query = query.filter_by(account_id=int(account_id))
            
        files = query.all()
        
        # Serialisasikan output JSON
        serialized = [f.to_dict() for f in files]
        serialized = merge_gpart_files(serialized)
        
        # Urutkan: folder terlebih dahulu, kemudian nama file secara alfabetis
        serialized.sort(key=lambda x: (
            0 if x.get('mimeType') == 'application/vnd.google-apps.folder' else 1,
            x.get('name', '').lower()
        ))
        
        return jsonify(serialized)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/search')
def api_search():
    """Pencarian global di database cache untuk kata kunci tertentu."""
    query_str = request.args.get('q', '')
    if not query_str:
        return jsonify([])

    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        # Cari file di cache yang dimiliki user_id dan namanya mengandung kata kunci (LIKE case-insensitive)
        files = db.query(FileCache)\
            .filter_by(user_id=user_id)\
            .filter(FileCache.name.like(f"%{query_str}%"))\
            .all()

        serialized = [f.to_dict() for f in files]
        serialized = merge_gpart_files(serialized)

        # Urutkan: folder terlebih dahulu, kemudian nama file secara alfabetis
        serialized.sort(key=lambda x: (
            0 if x.get('mimeType') == 'application/vnd.google-apps.folder' else 1,
            x.get('name', '').lower()
        ))

        return jsonify(serialized)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/sync', methods=['POST'])
def api_sync():
    """Sinkronisasikan ulang cache database secara sinkron."""
    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        accounts = db.query(Account).filter_by(user_id=user_id).all()
        success = sync_all_accounts_cache(db, accounts)
        if success:
            return jsonify({'success': True})
        return jsonify({'error': 'Sinkronisasi metadata gagal'}), 500
    finally:
        db.close()


@app.route('/api/folders/create', methods=['POST'])
def api_create_folder():
    """Buat folder baru di Google Drive."""
    data = request.get_json() or {}
    folder_name = data.get('name')
    parent_id = data.get('parent_id', 'root')
    account_id = data.get('account_id')

    if not folder_name:
        return jsonify({'error': 'Nama folder diperlukan'}), 400

    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        accounts = db.query(Account).filter_by(user_id=user_id).all()
        if not accounts:
            return jsonify({'error': 'Belum ada akun Google Drive terhubung'}), 400

        # Cari akun target
        target_account = None
        if account_id:
            target_account = db.query(Account).filter_by(id=int(account_id), user_id=user_id).first()
        elif parent_id != 'root':
            # Cari folder induk di cache untuk melihat pemiliknya
            parent_folder = db.query(FileCache).filter_by(file_id=parent_id, user_id=user_id).first()
            if parent_folder:
                target_account = db.query(Account).filter_by(id=parent_folder.account_id, user_id=user_id).first()

        # Fallback: pilih akun dengan sisa penyimpanan terbanyak (Smart Upload)
        if not target_account:
            account_spaces = []
            for acc in accounts:
                quota = get_storage_quota(acc)
                free = quota['total'] - quota['used']
                account_spaces.append((acc, free))
            account_spaces.sort(key=lambda x: x[1], reverse=True)
            target_account = account_spaces[0][0]

        # Buat folder asli di Drive
        folder = drive_create_folder(target_account, folder_name, parent_id)
        
        # Tambahkan folder baru langsung ke cache agar instan muncul di UI
        new_cache = FileCache(
            file_id=folder.get('id'),
            name=folder.get('name'),
            mime_type='application/vnd.google-apps.folder',
            size=0,
            parent_id=parent_id,
            account_id=target_account.id,
            user_id=user_id,
            is_starred=0,
            is_shared=0
        )
        db.add(new_cache)
        db.commit()
        
        # Picu background sync untuk verifikasi
        start_background_sync(user_id=user_id)
        return jsonify({'success': True, 'folder': folder})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/files/move', methods=['POST'])
def api_move_file():
    """Pindahkan file lintas akun Google Drive (Cross-Account Mover)."""
    data = request.get_json() or {}
    file_id = data.get('file_id')
    target_account_id = data.get('target_account_id')

    if not file_id or not target_account_id:
        return jsonify({'error': 'file_id dan target_account_id diperlukan'}), 400

    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        # Cari file di cache
        file_meta = db.query(FileCache).filter_by(file_id=file_id, user_id=user_id).first()
        if not file_meta:
            return jsonify({'error': 'File tidak terdaftar di cache'}), 404

        source_account = db.query(Account).filter_by(id=file_meta.account_id, user_id=user_id).first()
        target_account = db.query(Account).filter_by(id=int(target_account_id), user_id=user_id).first()

        if not source_account or not target_account:
            return jsonify({'error': 'Akun asal atau target tidak ditemukan'}), 404

        if source_account.id == target_account.id:
            return jsonify({'error': 'Akun asal dan target sama'}), 400

        # 1. Download file stream dari akun asal
        fh, filename, mime_type = drive_download(source_account, file_id)
        
        # 2. Upload file stream ke akun target (ke root akun target)
        drive_upload_file(target_account, fh, filename, mime_type, 'root')
        
        # 3. Hapus file di akun asal secara riil
        drive_delete(source_account, file_id)
        
        # Hapus file lama dari cache dan simpan perubahan
        db.delete(file_meta)
        db.commit()
        
        start_background_sync(user_id=user_id)
        return jsonify({'success': True, 'message': f'File berhasil dipindahkan ke {target_account.email}'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/duplicates')
def api_duplicates():
    """Cari daftar file duplikat di cache database."""
    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        duplicates = detect_duplicate_files(db, user_id)
        return jsonify(duplicates)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/upload', methods=['POST'])
def api_upload():
    """Upload file — otomatis pilih akun dengan ruang terbanyak (smart upload)."""
    if 'file' not in request.files:
        return jsonify({'error': 'Tidak ada file yang dikirim'}), 400

    file = request.files['file']
    folder_id = request.form.get('folder_id', 'root')

    if file.filename == '':
        return jsonify({'error': 'Tidak ada file yang dipilih'}), 400

    # Dapatkan ukuran file dari stream tanpa membaca seluruhnya ke memori
    file.stream.seek(0, 2)  # seek ke akhir file
    file_size = file.stream.tell()
    file.stream.seek(0)  # kembalikan ke awal file

    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        accounts = db.query(Account).filter_by(user_id=user_id).all()
        if not accounts:
            return jsonify({'error': 'Belum ada akun yang terhubung'}), 400

        def progress_callback(bytes_uploaded, total_bytes):
            percentage = (bytes_uploaded / total_bytes * 100) if total_bytes else 0
            active_uploads_progress[file.filename] = {
                'bytes_uploaded': bytes_uploaded,
                'total_bytes': total_bytes,
                'percentage': round(percentage, 2)
            }
            print(f"[Smart Upload] {file.filename} progress: {bytes_uploaded}/{total_bytes} ({percentage:.2f}%)")

        result = smart_upload(
            accounts, file.stream, file.filename,
            file.content_type or 'application/octet-stream',
            file_size, folder_id, progress_callback=progress_callback
        )
        
        if result.get('success'):
            if result.get('is_gpart'):
                for part in result.get('parts', []):
                    uploaded_part = part.get('file', {})
                    new_cache = FileCache(
                        file_id=uploaded_part.get('id'),
                        name=part.get('name') or uploaded_part.get('name'),
                        mime_type=file.content_type or 'application/octet-stream',
                        size=part.get('size'),
                        parent_id=folder_id,
                        account_id=part.get('account_id'),
                        user_id=user_id,
                        is_starred=0,
                        is_shared=0
                    )
                    db.add(new_cache)
                db.commit()
            else:
                # Masukkan entri buatan sementara ke cache
                uploaded_file = result.get('file', {})
                new_cache = FileCache(
                    file_id=uploaded_file.get('id'),
                    name=uploaded_file.get('name'),
                    mime_type=file.content_type or 'application/octet-stream',
                    size=file_size,
                    parent_id=folder_id,
                    account_id=result.get('account_id'),
                    user_id=user_id,
                    is_starred=0,
                    is_shared=0
                )
                db.add(new_cache)
                db.commit()
            start_background_sync(user_id=user_id)
            
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()
        try:
            if 'file' in request.files and file.filename in active_uploads_progress:
                del active_uploads_progress[file.filename]
        except Exception:
            pass


@app.route('/api/upload/progress')
def api_upload_progress():
    filename = request.args.get('filename')
    if filename and filename in active_uploads_progress:
        return jsonify(active_uploads_progress[filename])
    return jsonify({'percentage': 0, 'status': 'idle'})


@app.route('/api/delete/<file_id>', methods=['DELETE'])
def api_delete_file(file_id):
    """Hapus file dari Google Drive."""
    account_id = request.args.get('account_id')
    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        
        # 1. Deteksi file virtual (gpart)
        if file_id.startswith('gpart:'):
            parts = file_id.split(':', 2)
            if len(parts) < 3:
                return jsonify({'error': 'Format ID file virtual tidak valid'}), 400
            parent_id = parts[1]
            base_name = parts[2]
            
            # Cari seluruh bagian file dari cache
            pattern = re.compile(rf"^{re.escape(base_name)}\.gpart\.(\d+)$")
            cached_parts = db.query(FileCache).filter_by(user_id=user_id, parent_id=parent_id).all()
            matching_parts = []
            for p in cached_parts:
                match = pattern.match(p.name)
                if match:
                    matching_parts.append(p)
                    
            if not matching_parts:
                return jsonify({'error': 'Bagian file tidak ditemukan di cache'}), 404
                
            for p in matching_parts:
                account = db.query(Account).filter_by(id=p.account_id, user_id=user_id).first()
                if account:
                    try:
                        drive_delete(account, p.file_id)
                    except Exception as del_err:
                        print(f"Gagal menghapus part {p.name} dari Google Drive: {del_err}")
                # Hapus dari cache database terlepas dari sukses/gagal di Google Drive
                db.delete(p)
            db.commit()
            start_background_sync(user_id=user_id)
            return jsonify({'success': True})
            
        else:
            if not account_id:
                return jsonify({'error': 'account_id diperlukan'}), 400
            account = db.query(Account).filter_by(id=int(account_id), user_id=user_id).first()
            if not account:
                return jsonify({'error': 'Akun tidak ditemukan'}), 404
            
            drive_delete(account, file_id)
            db.query(FileCache).filter_by(file_id=file_id, user_id=user_id).delete()
            db.commit()
            start_background_sync(user_id=user_id)
            return jsonify({'success': True})
            
    except Exception as e:
        db.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/rename/<file_id>', methods=['PUT'])
def api_rename_file(file_id):
    """Rename file di Google Drive."""
    account_id = request.args.get('account_id')
    data = request.get_json()
    new_name = data.get('name') if data else None

    if not new_name:
        return jsonify({'error': 'name diperlukan'}), 400

    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        
        # 1. Deteksi file virtual (gpart)
        if file_id.startswith('gpart:'):
            parts = file_id.split(':', 2)
            if len(parts) < 3:
                return jsonify({'error': 'Format ID file virtual tidak valid'}), 400
            parent_id = parts[1]
            base_name = parts[2]
            
            pattern = re.compile(rf"^{re.escape(base_name)}\.gpart\.(\d+)$")
            cached_parts = db.query(FileCache).filter_by(user_id=user_id, parent_id=parent_id).all()
            matching_parts = []
            for p in cached_parts:
                match = pattern.match(p.name)
                if match:
                    part_num = int(match.group(1))
                    matching_parts.append((part_num, p))
                    
            if not matching_parts:
                return jsonify({'error': 'Bagian file tidak ditemukan'}), 404
                
            # Urutkan berdasarkan part_num agar penamaan rapi
            matching_parts.sort(key=lambda x: x[0])
            
            for part_num, p in matching_parts:
                new_part_name = f"{new_name}.gpart.{part_num:03d}"
                account = db.query(Account).filter_by(id=p.account_id, user_id=user_id).first()
                if account:
                    try:
                        drive_rename(account, p.file_id, new_part_name)
                    except Exception as ren_err:
                        print(f"Gagal me-rename part {p.name} ke {new_part_name}: {ren_err}")
                p.name = new_part_name
            db.commit()
            start_background_sync(user_id=user_id)
            return jsonify({'success': True, 'name': new_name})
            
        else:
            if not account_id:
                return jsonify({'error': 'account_id diperlukan'}), 400
            account = db.query(Account).filter_by(id=int(account_id), user_id=user_id).first()
            if not account:
                return jsonify({'error': 'Akun tidak ditemukan'}), 404
            
            result = drive_rename(account, file_id, new_name)
            cache_item = db.query(FileCache).filter_by(file_id=file_id, user_id=user_id).first()
            if cache_item:
                cache_item.name = new_name
                db.commit()
            start_background_sync(user_id=user_id)
            return jsonify(result)
            
    except Exception as e:
        db.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/files/star/<file_id>', methods=['PUT'])
def api_star_file(file_id):
    """Beri Bintang / Hapus Bintang file di Google Drive."""
    account_id = request.args.get('account_id')
    data = request.get_json() or {}
    starred = data.get('starred', False)

    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        
        # 1. Deteksi file virtual (gpart)
        if file_id.startswith('gpart:'):
            parts = file_id.split(':', 2)
            if len(parts) < 3:
                return jsonify({'error': 'Format ID file virtual tidak valid'}), 400
            parent_id = parts[1]
            base_name = parts[2]
            
            pattern = re.compile(rf"^{re.escape(base_name)}\.gpart\.(\d+)$")
            cached_parts = db.query(FileCache).filter_by(user_id=user_id, parent_id=parent_id).all()
            matching_parts = []
            for p in cached_parts:
                match = pattern.match(p.name)
                if match:
                    matching_parts.append(p)
                    
            if not matching_parts:
                return jsonify({'error': 'Bagian file tidak ditemukan'}), 404
                
            for p in matching_parts:
                account = db.query(Account).filter_by(id=p.account_id, user_id=user_id).first()
                if account:
                    try:
                        drive_toggle_starred(account, p.file_id, starred)
                    except Exception as err:
                        print(f"Gagal men-toggle bintang part {p.name}: {err}")
                p.is_starred = 1 if starred else 0
            db.commit()
            start_background_sync(user_id=user_id)
            return jsonify({'success': True, 'starred': starred})
            
        else:
            if not account_id:
                return jsonify({'error': 'account_id diperlukan'}), 400
            account = db.query(Account).filter_by(id=int(account_id), user_id=user_id).first()
            if not account:
                return jsonify({'error': 'Akun tidak ditemukan'}), 404
            
            drive_toggle_starred(account, file_id, starred)
            cache_item = db.query(FileCache).filter_by(file_id=file_id, user_id=user_id).first()
            if cache_item:
                cache_item.is_starred = 1 if starred else 0
                db.commit()
            start_background_sync(user_id=user_id)
            return jsonify({'success': True, 'starred': starred})
            
    except Exception as e:
        db.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/files/share/<file_id>', methods=['PUT'])
def api_share_file(file_id):
    """Bagikan / Hentikan Berbagi file di Google Drive."""
    account_id = request.args.get('account_id')
    data = request.get_json() or {}
    shared = data.get('shared', False)

    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        
        # 1. Deteksi file virtual (gpart)
        if file_id.startswith('gpart:'):
            parts = file_id.split(':', 2)
            if len(parts) < 3:
                return jsonify({'error': 'Format ID file virtual tidak valid'}), 400
            parent_id = parts[1]
            base_name = parts[2]
            
            pattern = re.compile(rf"^{re.escape(base_name)}\.gpart\.(\d+)$")
            cached_parts = db.query(FileCache).filter_by(user_id=user_id, parent_id=parent_id).all()
            matching_parts = []
            for p in cached_parts:
                match = pattern.match(p.name)
                if match:
                    matching_parts.append(p)
                    
            if not matching_parts:
                return jsonify({'error': 'Bagian file tidak ditemukan'}), 404
                
            for p in matching_parts:
                account = db.query(Account).filter_by(id=p.account_id, user_id=user_id).first()
                if account:
                    try:
                        drive_toggle_shared(account, p.file_id, shared)
                    except Exception as err:
                        print(f"Gagal men-toggle berbagi part {p.name}: {err}")
                p.is_shared = 1 if shared else 0
            db.commit()
            start_background_sync(user_id=user_id)
            return jsonify({'success': True, 'shared': shared})
            
        else:
            if not account_id:
                return jsonify({'error': 'account_id diperlukan'}), 400
            account = db.query(Account).filter_by(id=int(account_id), user_id=user_id).first()
            if not account:
                return jsonify({'error': 'Akun tidak ditemukan'}), 404
            
            drive_toggle_shared(account, file_id, shared)
            cache_item = db.query(FileCache).filter_by(file_id=file_id, user_id=user_id).first()
            if cache_item:
                cache_item.is_shared = 1 if shared else 0
                db.commit()
            start_background_sync(user_id=user_id)
            return jsonify({'success': True, 'shared': shared})
            
    except Exception as e:
        db.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/download/<file_id>')
def api_download_file(file_id):
    """Download file dari Google Drive."""
    account_id = request.args.get('account_id')
    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        
        # 1. Deteksi file virtual (gpart)
        if file_id.startswith('gpart:'):
            parts = file_id.split(':', 2)
            if len(parts) < 3:
                return jsonify({'error': 'Format ID file virtual tidak valid'}), 400
            parent_id = parts[1]
            base_name = parts[2]
            
            pattern = re.compile(rf"^{re.escape(base_name)}\.gpart\.(\d+)$")
            cached_parts = db.query(FileCache).filter_by(user_id=user_id, parent_id=parent_id).all()
            matching_parts = []
            for p in cached_parts:
                match = pattern.match(p.name)
                if match:
                    part_num = int(match.group(1))
                    matching_parts.append((part_num, p))
                    
            if not matching_parts:
                return jsonify({'error': 'File tidak ditemukan'}), 404
                
            # Urutkan berdasarkan part_num
            matching_parts.sort(key=lambda x: x[0])
            
            # Validasi aksesibilitas semua akun part terlebih dahulu
            accounts_map = {}
            for part_num, p in matching_parts:
                account = db.query(Account).filter_by(id=p.account_id, user_id=user_id).first()
                if not account:
                    return jsonify({'error': f"Akun Google Drive untuk file part '{p.name}' tidak dapat diakses atau telah dihapus."}), 400
                try:
                    # Validasi service
                    from drive_service import get_drive_service
                    get_drive_service(account)
                except Exception as acc_err:
                    return jsonify({'error': f"Gagal mengakses akun {account.email}: {acc_err}"}), 400
                accounts_map[p.file_id] = account
                
            # Stream sekuensial dari masing-masing part
            def stream_parts():
                for part_num, p in matching_parts:
                    acc = accounts_map[p.file_id]
                    fh, filename, mime_type = drive_download(acc, p.file_id)
                    try:
                        while True:
                            chunk = fh.read(1024 * 1024)  # 1MB chunks
                            if not chunk:
                                break
                            yield chunk
                    finally:
                        fh.close()
                        
            first_part = matching_parts[0][1]
            return Response(
                stream_parts(),
                mimetype=first_part.mime_type or 'application/octet-stream',
                headers={
                    'Content-Disposition': f'attachment; filename="{base_name}"'
                }
            )
            
        else:
            if not account_id:
                return jsonify({'error': 'account_id diperlukan'}), 400
            account = db.query(Account).filter_by(id=int(account_id), user_id=user_id).first()
            if not account:
                return jsonify({'error': 'Akun tidak ditemukan'}), 404
                
            file_stream, filename, mime_type = drive_download(account, file_id)
            return send_file(
                file_stream,
                download_name=filename,
                as_attachment=True,
                mimetype=mime_type
            )
            
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


# ============================================================
# Debug Endpoint (untuk diagnosis)
# ============================================================

@app.route('/api/debug')
def api_debug():
    """Test koneksi langsung ke Google Drive API — untuk diagnosis."""
    db = SessionLocal()
    try:
        user_id = getattr(request, 'user_id', None)
        accounts = db.query(Account).filter_by(user_id=user_id).all()
        results = []
        for account in accounts:
            acc_result = {
                'email': account.email,
                'has_refresh_token': bool(account.refresh_token),
                'has_access_token': bool(account.access_token),
            }
            try:
                from drive_service import get_drive_service
                service, creds = get_drive_service(account)
                about = service.about().get(fields='storageQuota,user').execute()
                acc_result['about_response'] = about
                acc_result['status'] = 'OK'
            except Exception as e:
                acc_result['status'] = 'ERROR'
                acc_result['error'] = str(e)
                acc_result['error_type'] = type(e).__name__
            results.append(acc_result)
        return jsonify(results)
    finally:
        db.close()


# ============================================================
# Run
# ============================================================
if __name__ == '__main__':
    app.run(debug=True, port=5050)
