"""
aggregator.py — Logika penggabungan virtual untuk beberapa akun Google Drive.
Termasuk: gabungan kuota, virtual directory, smart upload, caching sync, dan deteksi duplikat.
"""

from sqlalchemy import func
from drive_service import get_storage_quota, list_files, upload_file, fetch_all_files, get_drive_service
from models import FileCache, Account


def get_total_quota(accounts):
    """Hitung gabungan kuota penyimpanan dari semua akun."""
    total = 0
    used = 0
    account_quotas = []

    for account in accounts:
        try:
            quota = get_storage_quota(account)
            total += quota['total']
            used += quota['used']
            account_quotas.append({
                'account_id': account.id,
                'email': quota['email'],
                'display_name': quota['display_name'],
                'total': quota['total'],
                'used': quota['used'],
                'free': quota['total'] - quota['used']
            })
            # Update kuota di database
            account.quota_total = quota['total']
            account.quota_used = quota['used']
            if quota.get('display_name'):
                account.display_name = quota['display_name']
        except Exception as e:
            account_quotas.append({
                'account_id': account.id,
                'email': account.email,
                'display_name': account.display_name or account.email,
                'total': account.quota_total or 0,
                'used': account.quota_used or 0,
                'free': (account.quota_total or 0) - (account.quota_used or 0),
                'error': str(e)
            })

    return {
        'total': total,
        'used': used,
        'free': total - used,
        'accounts': account_quotas
    }


def get_merged_files(accounts, folder_id='root'):
    """Gabungkan daftar file dari semua akun menjadi satu daftar virtual."""
    merged = []
    for account in accounts:
        try:
            files = list_files(account, folder_id)
            merged.extend(files)
        except Exception as e:
            print(f"Error listing files for {account.email}: {e}")

    # Urutkan: folder dulu, lalu berdasarkan nama
    merged.sort(key=lambda x: (
        0 if x.get('mimeType') == 'application/vnd.google-apps.folder' else 1,
        x.get('name', '').lower()
    ))
    return merged


def merge_gpart_files(files_list):
    """
    Mengelompokkan file dengan pola .gpart.NNN menjadi satu file virtual terpadu.
    """
    import re
    pattern = re.compile(r'^(.*)\.gpart\.(\d+)$')
    groups = {}  # key: (parent_id, base_name) -> list of (part_num, file_dict)
    non_gparts = []

    for f in files_list:
        match = pattern.match(f['name'])
        if match:
            base_name = match.group(1)
            part_num = int(match.group(2))
            parent_id = f['parent_id']
            key = (parent_id, base_name)
            if key not in groups:
                groups[key] = []
            groups[key].append((part_num, f))
        else:
            non_gparts.append(f)

    for (parent_id, base_name), parts in groups.items():
        parts.sort(key=lambda x: x[0])
        total_size = sum(p[1]['size'] for p in parts)
        modified_times = [p[1]['modifiedTime'] for p in parts if p[1].get('modifiedTime')]
        latest_modified = max(modified_times) if modified_times else None
        
        is_starred = any(p[1].get('is_starred') for p in parts)
        is_shared = any(p[1].get('is_shared') for p in parts)
        
        first_part = parts[0][1]
        virtual_id = f"gpart:{parent_id}:{base_name}"
        
        virtual_file = {
            'id': virtual_id,
            'name': base_name,
            'mimeType': first_part.get('mimeType', 'application/octet-stream'),
            'size': int(total_size),
            'modifiedTime': latest_modified or first_part.get('modifiedTime'),
            'parent_id': parent_id,
            'account_id': first_part['account_id'],
            'is_starred': is_starred,
            'is_shared': is_shared,
            'is_gpart': True,
            'parts': [p[1] for p in parts]
        }
        non_gparts.append(virtual_file)

    return non_gparts


def smart_upload(accounts, file_stream, filename, mime_type, file_size, folder_id='root', progress_callback=None):
    """
    Upload file secara cerdas ke akun yang memiliki ruang paling banyak.
    Cek sisa kuota tiap akun. Jika tidak ada akun tunggal yang cukup,
    pecah file menjadi bagian-bagian dan upload ke beberapa akun.
    """
    import tempfile
    from drive_service import delete_file as drive_delete

    # Kumpulkan info ruang kosong per akun, urutkan dari yang paling banyak
    account_spaces = []
    for account in accounts:
        try:
            quota = get_storage_quota(account)
            free_space = quota['total'] - quota['used']
            account_spaces.append((account, free_space, quota['email']))
        except Exception as e:
            print(f"Error checking quota for {account.email}: {e}")
            continue

    # Urutkan berdasarkan ruang kosong terbesar
    account_spaces.sort(key=lambda x: x[1], reverse=True)

    # 1. Coba upload langsung ke akun tunggal yang muat
    for account, free_space, email in account_spaces:
        if free_space >= file_size:
            result = upload_file(account, file_stream, filename, mime_type, folder_id, progress_callback=progress_callback)
            return {
                'success': True,
                'file': result,
                'uploaded_to': email,
                'account_id': account.id
            }

    # 2. Jika tidak muat di satu akun, coba gunakan gabungan penyimpanan
    # Tetapkan batas aman (buffer) 10 MB per akun
    buffer_size = 10 * 1024 * 1024
    usable_spaces = []
    total_usable = 0
    for account, free_space, email in account_spaces:
        usable = max(0, free_space - buffer_size)
        if usable > 0:
            usable_spaces.append((account, usable, email))
            total_usable += usable

    if total_usable < file_size:
        return {
            'success': False,
            'error': 'Tidak ada akun dengan ruang penyimpanan yang cukup untuk file ini.'
        }

    # Tentukan alokasi ukuran part
    remaining_size = file_size
    allocations = []
    for account, usable, email in usable_spaces:
        if remaining_size <= 0:
            break
        allocated = min(remaining_size, usable)
        allocations.append((account, allocated, email))
        remaining_size -= allocated

    uploaded_parts = []
    try:
        for i, (account, allocated_size, email) in enumerate(allocations, 1):
            part_filename = f"{filename}.gpart.{i:03d}"
            
            # Buat file sementara untuk menampung part tersebut
            temp_fh = tempfile.TemporaryFile()
            bytes_written = 0
            while bytes_written < allocated_size:
                chunk_to_read = min(1024 * 1024, int(allocated_size - bytes_written))
                block = file_stream.read(chunk_to_read)
                if not block:
                    break
                temp_fh.write(block)
                bytes_written += len(block)

            if bytes_written < allocated_size:
                raise IOError(f"Unexpected EOF: expected {allocated_size} bytes, got {bytes_written}")

            temp_fh.seek(0)
            
            # Upload part ke Google Drive
            part_result = upload_file(
                account, temp_fh, part_filename, mime_type, folder_id,
                progress_callback=progress_callback
            )
            uploaded_parts.append((account, part_result, part_filename, bytes_written))
            temp_fh.close()

        return {
            'success': True,
            'is_gpart': True,
            'parts': [
                {
                    'file': res,
                    'name': name,
                    'uploaded_to': acc.email,
                    'account_id': acc.id,
                    'size': sz
                }
                for acc, res, name, sz in uploaded_parts
            ]
        }

    except Exception as e:
        # Rollback: Hapus part yang sudah sempat ter-upload jika terjadi error
        print(f"Upload split file gagal: {e}. Melakukan rollback...")
        for acc, res, name, sz in uploaded_parts:
            try:
                drive_delete(acc, res.get('id'))
            except Exception as del_err:
                print(f"Gagal menghapus part {name} saat rollback: {del_err}")
        return {
            'success': False,
            'error': f'Gagal mengupload file: {str(e)}'
        }



def sync_all_accounts_cache(db, accounts):
    """Ambil metadata terbaru dari semua akun Google Drive dan sinkronkan ke database lokal."""
    try:
        # Hapus cache file lama di database hanya untuk akun-akun ini
        account_ids = [acc.id for acc in accounts]
        if account_ids:
            db.query(FileCache).filter(FileCache.account_id.in_(account_ids)).delete(synchronize_session=False)
        
        for account in accounts:
            try:
                # 1. Ambil & perbarui kapasitas kuota akun terbaru
                quota = get_storage_quota(account)
                account.quota_total = quota['total']
                account.quota_used = quota['used']
                if quota.get('display_name'):
                    account.display_name = quota['display_name']
                
                # Ambil root ID riil dari Google Drive untuk dipetakan ke alias 'root'
                service, _ = get_drive_service(account)
                try:
                    root_id = service.files().get(fileId='root', fields='id').execute().get('id')
                except Exception as e:
                    print(f"Gagal mengambil root ID untuk {account.email}: {e}")
                    root_id = None
                
                # 2. Ambil seluruh file dari Google Drive secara massal
                drive_files = fetch_all_files(account)
                for f in drive_files:
                    parents = f.get('parents', [])
                    parent_id = parents[0] if parents else 'root'
                    
                    # Jika parent adalah root ID riil akun ini, petakan ke alias 'root'
                    if root_id and parent_id == root_id:
                        parent_id = 'root'
                        
                    # Simpan data file baru ke cache database
                    cache_item = FileCache(
                        file_id=f.get('id'),
                        name=f.get('name'),
                        mime_type=f.get('mimeType'),
                        size=float(f.get('size', 0)) if f.get('size') else 0.0,
                        modified_time=f.get('modifiedTime'),
                        parent_id=parent_id,
                        account_id=account.id,
                        user_id=account.user_id,
                        is_starred=1 if f.get('starred') else 0,
                        is_shared=1 if f.get('shared') else 0
                    )
                    db.add(cache_item)
            except Exception as inner_err:
                print(f"Gagal mensinkronisasikan file untuk {account.email}: {inner_err}")
                
        db.commit()
        return True
    except Exception as e:
        db.rollback()
        print(f"Error fatal saat menjalankan sinkronisasi cache: {e}")
        return False


def detect_duplicate_files(db, user_id):
    """
    Cari file duplikat (nama dan ukuran sama, size > 0) di database cache untuk user tertentu.
    Mengembalikan daftar file duplikat terkelompok.
    """
    # Cari nama dan ukuran file yang terduplikasi (bukan folder) untuk user aktif
    dup_query = db.query(FileCache.name, FileCache.size)\
        .filter(FileCache.user_id == user_id)\
        .filter(FileCache.size > 0)\
        .filter(FileCache.mime_type != 'application/vnd.google-apps.folder')\
        .group_by(FileCache.name, FileCache.size)\
        .having(func.count(FileCache.id) > 1)\
        .all()
        
    duplicates = []
    for name, size in dup_query:
        # Kueri semua instansi file yang memiliki kecocokan nama dan ukuran
        matching_files = db.query(FileCache).filter_by(user_id=user_id, name=name, size=size).all()
        
        file_list = []
        for f in matching_files:
            acc = db.query(Account).filter_by(id=f.account_id).first()
            email = acc.email if acc else 'Unknown'
            
            file_list.append({
                'id': f.file_id,
                'name': f.name,
                'size': int(f.size) if f.size else 0,
                'modifiedTime': f.modified_time,
                'account_id': f.account_id,
                'account_email': email
            })
            
        duplicates.append({
            'name': name,
            'size': int(size) if size else 0,
            'items': file_list
        })
        
    return duplicates
