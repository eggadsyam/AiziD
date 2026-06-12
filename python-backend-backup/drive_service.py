"""
drive_service.py — Fungsi-fungsi untuk berinteraksi dengan Google Drive API.
Termasuk: buat service, cek kuota, list file, upload, download, delete, rename.
"""

import io
import tempfile
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload, MediaIoBaseDownload


def get_drive_service(account):
    """Buat Google Drive API service dari kredensial akun yang tersimpan."""
    creds = Credentials(
        token=account.access_token,
        refresh_token=account.refresh_token,
        token_uri=account.token_uri,
        client_id=account.client_id,
        client_secret=account.client_secret,
        scopes=['https://www.googleapis.com/auth/drive']
    )
    service = build('drive', 'v3', credentials=creds, cache_discovery=False)
    return service, creds


def get_storage_quota(account):
    """Ambil informasi kuota penyimpanan untuk satu akun."""
    service, creds = get_drive_service(account)
    about = service.about().get(fields='storageQuota,user').execute()
    quota = about.get('storageQuota', {})
    user = about.get('user', {})
    return {
        'total': int(quota.get('limit', 0)),
        'used': int(quota.get('usage', 0)),
        'email': user.get('emailAddress', ''),
        'display_name': user.get('displayName', '')
    }


def list_files(account, folder_id='root', page_size=100):
    """Ambil daftar file dan folder dari folder tertentu di Drive."""
    service, creds = get_drive_service(account)
    query = f"'{folder_id}' in parents and trashed = false"
    results = service.files().list(
        q=query,
        pageSize=page_size,
        fields="nextPageToken, files(id, name, mimeType, size, modifiedTime, parents, iconLink, thumbnailLink, webViewLink)",
        orderBy="folder,name"
    ).execute()
    files = results.get('files', [])
    # Tambahkan info akun ke setiap file
    for f in files:
        f['account_id'] = account.id
        f['account_email'] = account.email
    return files


def upload_file(account, file_stream, filename, mime_type, folder_id='root', progress_callback=None):
    """Upload file ke Google Drive."""
    service, creds = get_drive_service(account)
    file_metadata = {
        'name': filename,
        'parents': [folder_id]
    }
    # Gunakan chunksize 10MB (harus kelipatan 256KB) untuk efisiensi memori
    media = MediaIoBaseUpload(file_stream, mimetype=mime_type, chunksize=10*1024*1024, resumable=True)
    request = service.files().create(
        body=file_metadata,
        media_body=media,
        fields='id, name, size'
    )
    
    response = None
    while response is None:
        status, response = request.next_chunk()
        if status and progress_callback:
            try:
                progress_callback(status.resumable_progress, status.total_size)
            except Exception as e:
                print(f"Error in progress callback: {e}")
                
    return response


def delete_file(account, file_id):
    """Hapus file dari Google Drive."""
    service, creds = get_drive_service(account)
    service.files().delete(fileId=file_id).execute()


def rename_file(account, file_id, new_name):
    """Rename file di Google Drive."""
    service, creds = get_drive_service(account)
    file = service.files().update(
        fileId=file_id,
        body={'name': new_name},
        fields='id, name'
    ).execute()
    return file


def download_file(account, file_id):
    """Download file dari Google Drive. Mendukung export Google Docs."""
    service, creds = get_drive_service(account)
    # Ambil metadata file dulu
    file_meta = service.files().get(fileId=file_id, fields='name, mimeType').execute()

    # Google Docs types perlu di-export ke format standar
    google_export_map = {
        'application/vnd.google-apps.document': ('application/pdf', '.pdf'),
        'application/vnd.google-apps.spreadsheet': (
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'
        ),
        'application/vnd.google-apps.presentation': (
            'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'
        ),
    }

    mime_type = file_meta.get('mimeType', '')
    filename = file_meta.get('name', 'download')

    if mime_type in google_export_map:
        export_mime, ext = google_export_map[mime_type]
        request = service.files().export_media(fileId=file_id, mimeType=export_mime)
        if not filename.endswith(ext):
            filename += ext
    else:
        request = service.files().get_media(fileId=file_id)

    # Download ke temporary file di disk (bukan memori) agar hemat RAM
    fh = tempfile.TemporaryFile()
    downloader = MediaIoBaseDownload(fh, request)
    done = False
    while not done:
        status, done = downloader.next_chunk()
    fh.seek(0)

    return fh, filename, mime_type


def fetch_all_files(account):
    """Ambil seluruh file dan folder dari satu akun Google Drive secara massal."""
    service, creds = get_drive_service(account)
    query = "trashed = false"
    
    files = []
    page_token = None
    while True:
        results = service.files().list(
            q=query,
            pageSize=1000,
            fields="nextPageToken, files(id, name, mimeType, size, modifiedTime, parents, starred, shared)",
            pageToken=page_token
        ).execute()
        files.extend(results.get('files', []))
        page_token = results.get('nextPageToken')
        if not page_token:
            break
            
    return files


def create_folder(account, folder_name, parent_id='root'):
    """Buat folder baru di Google Drive."""
    service, creds = get_drive_service(account)
    file_metadata = {
        'name': folder_name,
        'mimeType': 'application/vnd.google-apps.folder',
        'parents': [parent_id]
    }
    folder = service.files().create(
        body=file_metadata,
        fields='id, name'
    ).execute()
    return folder


def toggle_starred(account, file_id, starred):
    """Toggle status bintang file di Google Drive."""
    service, creds = get_drive_service(account)
    body = {'starred': starred}
    service.files().update(fileId=file_id, body=body, fields='id, starred').execute()


def toggle_shared(account, file_id, shared):
    """Toggle status berbagi file di Google Drive (anyone reader permission)."""
    service, creds = get_drive_service(account)
    if shared:
        permission = {
            'type': 'anyone',
            'role': 'reader'
        }
        service.permissions().create(fileId=file_id, body=permission, fields='id').execute()
    else:
        # Cari izin 'anyone' dan hapus
        permissions = service.permissions().list(fileId=file_id, fields='permissions(id, type)').execute().get('permissions', [])
        for perm in permissions:
            if perm.get('type') == 'anyone':
                service.permissions().delete(fileId=file_id, permissionId=perm.get('id')).execute()
