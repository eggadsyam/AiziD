import os
import unittest
import tempfile
import tracemalloc
from unittest.mock import MagicMock, patch, PropertyMock
from werkzeug.datastructures import FileStorage

# Set temporary test database
TEST_DB_FILE = "test_database.db"
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_FILE}"

from models import init_db, SessionLocal, Account, FileCache, User, engine
from app import app
import drive_service

# Custom stream representing a 10GB file
class ZeroStream:
    def __init__(self, size):
        self.size = size
        self.position = 0

    def read(self, size=-1):
        if self.position >= self.size:
            return b""
        chunk_size = size if size != -1 else (self.size - self.position)
        chunk_size = min(chunk_size, self.size - self.position)
        self.position += chunk_size
        return b"\x00" * chunk_size

    def seek(self, offset, whence=0):
        if whence == 0:
            self.position = offset
        elif whence == 1:
            self.position += offset
        elif whence == 2:
            self.position = self.size + offset
        return self.position

    def tell(self):
        return self.position

class MockMediaIoBaseDownload:
    def __init__(self, fh, request):
        self.fh = fh
        self.request = request
    def next_chunk(self):
        self.fh.write(b"mock_download_data")
        return None, True

class E2ETestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Ensure clean environment
        if os.path.exists(TEST_DB_FILE):
            try:
                os.remove(TEST_DB_FILE)
            except Exception:
                pass
        init_db()
        cls.client = app.test_client()

    @classmethod
    def tearDownClass(cls):
        # Clean up database
        engine.dispose()
        if os.path.exists(TEST_DB_FILE):
            try:
                os.remove(TEST_DB_FILE)
            except Exception as e:
                print(f"Failed to remove test DB: {e}")

    def setUp(self):
        # Setup Google API mock services
        self.mock_creds = MagicMock()
        self.mock_service1 = MagicMock()
        self.mock_service2 = MagicMock()
        
        # Configure quota responses
        self.mock_service1.about().get().execute.return_value = {
            'storageQuota': {'limit': 15 * 1024 * 1024 * 1024, 'usage': 5 * 1024 * 1024 * 1024},
            'user': {'emailAddress': 'test1@gmail.com', 'displayName': 'Test 1'}
        }
        self.mock_service2.about().get().execute.return_value = {
            'storageQuota': {'limit': 5 * 1024 * 1024 * 1024, 'usage': 4 * 1024 * 1024 * 1024},
            'user': {'emailAddress': 'test2@gmail.com', 'displayName': 'Test 2'}
        }

        # Configure default file listing responses
        self.mock_service1.files().list().execute.return_value = {
            'files': [
                {'id': 'file1', 'name': 'file_to_move.txt', 'mimeType': 'text/plain', 'size': '1024', 'modifiedTime': '2026-06-11T12:00:00Z', 'starred': False, 'shared': False},
                {'id': 'file2', 'name': 'duplicate.txt', 'mimeType': 'text/plain', 'size': '5000', 'modifiedTime': '2026-06-11T12:00:00Z', 'starred': False, 'shared': False}
            ]
        }
        self.mock_service2.files().list().execute.return_value = {
            'files': [
                {'id': 'file3', 'name': 'duplicate.txt', 'mimeType': 'text/plain', 'size': '5000', 'modifiedTime': '2026-06-11T12:00:00Z', 'starred': False, 'shared': False}
            ]
        }

        # Configure root folder ID responses and fallback behaviors for files().get()
        default_get_mock1 = MagicMock()
        default_get_mock2 = MagicMock()
        
        def get_side_effect1(*args, **kwargs):
            fileId = kwargs.get('fileId') or (args[0] if args else None)
            if fileId == 'root':
                mock_req = MagicMock()
                mock_req.execute.return_value = {'id': 'root_id_1'}
                return mock_req
            if not fileId:
                return default_get_mock1
            mock_req = MagicMock()
            mock_req.execute.side_effect = lambda *a, **kw: default_get_mock1.execute()
            return mock_req

        def get_side_effect2(*args, **kwargs):
            fileId = kwargs.get('fileId') or (args[0] if args else None)
            if fileId == 'root':
                mock_req = MagicMock()
                mock_req.execute.return_value = {'id': 'root_id_2'}
                return mock_req
            if not fileId:
                return default_get_mock2
            mock_req = MagicMock()
            mock_req.execute.side_effect = lambda *a, **kw: default_get_mock2.execute()
            return mock_req

        self.mock_service1.files().get.side_effect = get_side_effect1
        self.mock_service2.files().get.side_effect = get_side_effect2

        # Patch get_drive_service dynamically
        def get_service_side_effect(account):
            if account.id == 1:
                return self.mock_service1, self.mock_creds
            else:
                return self.mock_service2, self.mock_creds

        self.patcher_service = patch('drive_service.get_drive_service', side_effect=get_service_side_effect)
        self.patcher_service.start()
        self.patcher_service_agg = patch('aggregator.get_drive_service', side_effect=get_service_side_effect)
        self.patcher_service_agg.start()
        
        # Patch MediaIoBaseDownload
        self.patcher_download = patch('drive_service.MediaIoBaseDownload', new=MockMediaIoBaseDownload)
        self.patcher_download.start()

        # Set default next_chunk mock values for create() requests
        self.mock_service1.files.return_value.create.return_value.next_chunk.return_value = (None, {'id': 'default_id', 'name': 'default.txt'})
        self.mock_service2.files.return_value.create.return_value.next_chunk.return_value = (None, {'id': 'default_id', 'name': 'default.txt'})

        # Patch start_background_sync to do absolutely nothing in tests
        self.patcher_bg_sync = patch('app.start_background_sync', lambda *args, **kwargs: None)
        self.patcher_bg_sync.start()

        # Clean and Re-seed DB to isolate test state
        db = SessionLocal()
        db.query(FileCache).delete()
        db.query(Account).delete()
        db.query(User).delete()
        
        user = User(id=1, username="local_user", password_hash="")
        db.add(user)
        db.commit()

        # Seed accounts
        self.acc1 = Account(
            id=1,
            user_id=1,
            email="test1@gmail.com",
            display_name="Test Account 1",
            access_token="fake_access_1",
            refresh_token="fake_refresh_1",
            token_uri="fake_uri_1",
            client_id="fake_client_1",
            client_secret="fake_secret_1",
            quota_total=15 * 1024 * 1024 * 1024,
            quota_used=5 * 1024 * 1024 * 1024
        )
        self.acc2 = Account(
            id=2,
            user_id=1,
            email="test2@gmail.com",
            display_name="Test Account 2",
            access_token="fake_access_2",
            refresh_token="fake_refresh_2",
            token_uri="fake_uri_2",
            client_id="fake_client_2",
            client_secret="fake_secret_2",
            quota_total=5 * 1024 * 1024 * 1024,
            quota_used=4 * 1024 * 1024 * 1024
        )
        db.add(self.acc1)
        db.add(self.acc2)

        # Seed files
        self.fc1 = FileCache(
            file_id="file1",
            name="file_to_move.txt",
            mime_type="text/plain",
            size=1024,
            parent_id="root",
            account_id=1,
            user_id=1,
            is_starred=0,
            is_shared=0
        )
        self.fc2 = FileCache(
            file_id="file2",
            name="duplicate.txt",
            mime_type="text/plain",
            size=5000,
            parent_id="root",
            account_id=1,
            user_id=1,
            is_starred=0,
            is_shared=0
        )
        self.fc3 = FileCache(
            file_id="file3",
            name="duplicate.txt",
            mime_type="text/plain",
            size=5000,
            parent_id="root",
            account_id=2,
            user_id=1,
            is_starred=0,
            is_shared=0
        )
        db.add(self.fc1)
        db.add(self.fc2)
        db.add(self.fc3)
        db.commit()
        db.close()

    def tearDown(self):
        self.patcher_service.stop()
        self.patcher_service_agg.stop()
        self.patcher_download.stop()
        self.patcher_bg_sync.stop()
        # Release connection pool to avoid file locks
        engine.dispose()

    def test_dashboard_page(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'AiziD', response.data)

    def test_api_accounts(self):
        response = self.client.get('/api/accounts')
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(len(data), 2)
        self.assertEqual(data[0]['email'], 'test1@gmail.com')
        self.assertEqual(data[1]['email'], 'test2@gmail.com')

    def test_api_quota(self):
        response = self.client.get('/api/quota')
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        # 15GB + 5GB = 20GB = 21474836480 bytes
        self.assertEqual(data['total'], 20 * 1024 * 1024 * 1024)
        # 5GB + 4GB = 9GB = 9663676416 bytes
        self.assertEqual(data['used'], 9 * 1024 * 1024 * 1024)

    def test_api_files(self):
        response = self.client.get('/api/files')
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(len(data) >= 3)

    def test_api_search(self):
        response = self.client.get('/api/search?q=move')
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]['name'], 'file_to_move.txt')

    def test_api_sync(self):
        self.mock_service1.files().list().execute.return_value = {
            'files': [
                {'id': 'sync_file_1', 'name': 'synced.txt', 'mimeType': 'text/plain', 'size': '2048', 'modifiedTime': '2026-06-11T12:00:00Z', 'starred': False, 'shared': False}
            ]
        }
        self.mock_service2.files().list().execute.return_value = {
            'files': []
        }
        response = self.client.post('/api/sync')
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])
        
        # Verify cache matches sync output
        db = SessionLocal()
        cached = db.query(FileCache).filter_by(file_id='sync_file_1').first()
        self.assertIsNotNone(cached)
        self.assertEqual(cached.name, 'synced.txt')
        db.close()

    def test_api_create_folder(self):
        self.mock_service1.files().create().execute.return_value = {
            'id': 'folder_created_id',
            'name': 'New Folder'
        }
        response = self.client.post('/api/folders/create', json={'name': 'New Folder', 'account_id': 1})
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])
        self.assertEqual(data['folder']['id'], 'folder_created_id')

    def test_api_move_file(self):
        self.mock_service2.files.return_value.create.return_value.next_chunk.return_value = (None, {
            'id': 'moved_file_new_id',
            'name': 'file_to_move.txt'
        })
        self.mock_service1.files().get().execute.return_value = {
            'name': 'file_to_move.txt',
            'mimeType': 'text/plain'
        }
        response = self.client.post('/api/files/move', json={
            'file_id': 'file1',
            'target_account_id': 2
        })
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])

        # Verify old cache deleted
        db = SessionLocal()
        cached = db.query(FileCache).filter_by(file_id='file1').first()
        self.assertIsNone(cached)
        db.close()

    def test_api_duplicates(self):
        response = self.client.get('/api/duplicates')
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]['name'], 'duplicate.txt')
        self.assertEqual(len(data[0]['items']), 2)

    def test_api_upload_normal(self):
        self.mock_service1.files.return_value.create.return_value.next_chunk.return_value = (None, {
            'id': 'upload_normal_id',
            'name': 'normal.txt'
        })
        small_stream = tempfile.TemporaryFile()
        small_stream.write(b"hello world")
        small_stream.seek(0)
        mock_file = FileStorage(
            stream=small_stream,
            filename="normal.txt",
            content_type="text/plain"
        )
        with patch('flask.Request.files', new_callable=PropertyMock) as mock_files_prop:
            mock_files_prop.return_value = {'file': mock_file}
            response = self.client.post('/api/upload', data={'folder_id': 'root'})
            
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])
        self.assertEqual(data['uploaded_to'], 'test1@gmail.com')

    def test_api_upload_10gb(self):
        # Track memory usage during 10GB streaming upload
        tracemalloc.start()
        
        create_mock = MagicMock()
        create_mock.next_chunk.return_value = (None, {
            'id': 'upload_10gb_id',
            'name': 'huge_10gb_file.dat',
            'size': 10 * 1024 * 1024 * 1024
        })
            
        def side_effect_create(*args, **kwargs):
            media_body = kwargs.get('media_body')
            if media_body:
                stream = media_body.stream()
                while True:
                    chunk = stream.read(10 * 1024 * 1024)
                    if not chunk:
                        break
            return create_mock

        self.mock_service1.files.return_value.create.side_effect = side_effect_create

        ten_gb = 10 * 1024 * 1024 * 1024
        mock_file = FileStorage(
            stream=ZeroStream(ten_gb),
            filename="huge_10gb_file.dat",
            content_type="application/octet-stream"
        )
        
        mem_before = tracemalloc.get_traced_memory()[1] # peak memory
        
        with patch('flask.Request.files', new_callable=PropertyMock) as mock_files_prop:
            mock_files_prop.return_value = {'file': mock_file}
            response = self.client.post('/api/upload', data={'folder_id': 'root'})

        mem_after = tracemalloc.get_traced_memory()[1] # peak memory
        peak_memory_used = mem_after - mem_before
        tracemalloc.stop()
        
        print(f"\n[E2E QA Test] Peak RAM used during 10GB streaming upload: {peak_memory_used / (1024*1024):.2f} MB")
        
        self.assertEqual(response.status_code, 200, f"Error response data: {response.get_data(as_text=True)}")
        data = response.get_json()
        self.assertTrue(data['success'])
        self.assertEqual(data['uploaded_to'], 'test1@gmail.com')
        
        # Verify RAM usage remains under 5MB
        self.assertLess(peak_memory_used, 5 * 1024 * 1024)

    def test_api_rename_file(self):
        self.mock_service1.files().update().execute.return_value = {
            'id': 'file2',
            'name': 'renamed.txt'
        }
        response = self.client.put('/api/rename/file2?account_id=1', json={'name': 'renamed.txt'})
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data['name'], 'renamed.txt')
        
        db = SessionLocal()
        cached = db.query(FileCache).filter_by(file_id='file2').first()
        self.assertEqual(cached.name, 'renamed.txt')
        db.close()

    def test_api_download_file(self):
        self.mock_service1.files().get().execute.return_value = {
            'name': 'synced.txt',
            'mimeType': 'text/plain'
        }
        response = self.client.get('/api/download/file2?account_id=1')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Content-Disposition'], 'attachment; filename=synced.txt')
        self.assertEqual(response.data, b"mock_download_data")

    def test_api_delete_file(self):
        response = self.client.delete('/api/delete/file2?account_id=1')
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])
        
        db = SessionLocal()
        cached = db.query(FileCache).filter_by(file_id='file2').first()
        self.assertIsNone(cached)
        db.close()

    def test_api_delete_account(self):
        response = self.client.delete('/api/accounts/2')
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])
        
        db = SessionLocal()
        acc = db.query(Account).filter_by(id=2).first()
        self.assertIsNone(acc)
        cached = db.query(FileCache).filter_by(account_id=2).all()
        self.assertEqual(len(cached), 0)
        db.close()

    def test_upload_split_file(self):
        # 1. Setup mock create responses for part uploads
        create_mock1 = MagicMock()
        create_mock1.next_chunk.return_value = (None, {
            'id': 'part1_id',
            'name': 'split_file.zip.gpart.001',
            'size': int(9.99 * 1024 * 1024 * 1024)
        })
        create_mock2 = MagicMock()
        create_mock2.next_chunk.return_value = (None, {
            'id': 'part2_id',
            'name': 'split_file.zip.gpart.002',
            'size': int(0.51 * 1024 * 1024 * 1024)
        })

        self.mock_service1.files.return_value.create.return_value = create_mock1
        self.mock_service2.files.return_value.create.return_value = create_mock2

        # 10.5 GB file
        file_size = int(10.5 * 1024 * 1024 * 1024)
        mock_file = FileStorage(
            stream=ZeroStream(file_size),
            filename="split_file.zip",
            content_type="application/zip"
        )

        with patch('flask.Request.files', new_callable=PropertyMock) as mock_files_prop:
            mock_files_prop.return_value = {'file': mock_file}
            response = self.client.post('/api/upload', data={'folder_id': 'root'})

        self.assertEqual(response.status_code, 200, f"Error: {response.get_data(as_text=True)}")
        data = response.get_json()
        self.assertTrue(data['success'])
        self.assertTrue(data['is_gpart'])
        self.assertEqual(len(data['parts']), 2)
        self.assertEqual(data['parts'][0]['file']['id'], 'part1_id')
        self.assertEqual(data['parts'][1]['file']['id'], 'part2_id')

        # Check FileCache database
        db = SessionLocal()
        parts = db.query(FileCache).filter(FileCache.name.like("split_file.zip.gpart.%")).all()
        self.assertEqual(len(parts), 2)
        db.close()

    def test_download_split_file(self):
        db = SessionLocal()
        p1 = FileCache(
            file_id="part1_id",
            name="split_file.zip.gpart.001",
            mime_type="application/zip",
            size=1000,
            parent_id="root",
            account_id=1,
            user_id=1
        )
        p2 = FileCache(
            file_id="part2_id",
            name="split_file.zip.gpart.002",
            mime_type="application/zip",
            size=500,
            parent_id="root",
            account_id=2,
            user_id=1
        )
        db.add(p1)
        db.add(p2)
        db.commit()
        db.close()

        self.mock_service1.files().get().execute.return_value = {
            'name': 'split_file.zip.gpart.001',
            'mimeType': 'application/zip'
        }
        self.mock_service2.files().get().execute.return_value = {
            'name': 'split_file.zip.gpart.002',
            'mimeType': 'application/zip'
        }

        response = self.client.get('/api/download/gpart:root:split_file.zip')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Content-Disposition'], 'attachment; filename="split_file.zip"')
        self.assertEqual(response.data, b"mock_download_datamock_download_data")

    def test_delete_split_file(self):
        db = SessionLocal()
        p1 = FileCache(
            file_id="part1_id_del",
            name="split_file_del.zip.gpart.001",
            mime_type="application/zip",
            size=1000,
            parent_id="root",
            account_id=1,
            user_id=1
        )
        p2 = FileCache(
            file_id="part2_id_del",
            name="split_file_del.zip.gpart.002",
            mime_type="application/zip",
            size=500,
            parent_id="root",
            account_id=2,
            user_id=1
        )
        db.add(p1)
        db.add(p2)
        db.commit()
        db.close()

        response = self.client.delete('/api/delete/gpart:root:split_file_del.zip')
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])

        db = SessionLocal()
        cached = db.query(FileCache).filter(FileCache.name.like("split_file_del.zip.gpart.%")).all()
        self.assertEqual(len(cached), 0)
        db.close()

    def test_rename_split_file(self):
        db = SessionLocal()
        p1 = FileCache(
            file_id="part1_id_ren",
            name="split_file_ren.zip.gpart.001",
            mime_type="application/zip",
            size=1000,
            parent_id="root",
            account_id=1,
            user_id=1
        )
        p2 = FileCache(
            file_id="part2_id_ren",
            name="split_file_ren.zip.gpart.002",
            mime_type="application/zip",
            size=500,
            parent_id="root",
            account_id=2,
            user_id=1
        )
        db.add(p1)
        db.add(p2)
        db.commit()
        db.close()

        self.mock_service1.files().update().execute.return_value = {'id': 'part1_id_ren', 'name': 'renamed_file.zip.gpart.001'}
        self.mock_service2.files().update().execute.return_value = {'id': 'part2_id_ren', 'name': 'renamed_file.zip.gpart.002'}

        response = self.client.put('/api/rename/gpart:root:split_file_ren.zip', json={'name': 'renamed_file.zip'})
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])

        db = SessionLocal()
        parts = db.query(FileCache).filter(FileCache.name.like("renamed_file.zip.gpart.%")).all()
        self.assertEqual(len(parts), 2)
        db.close()

    def test_upload_split_file_failure_rollback(self):
        create_mock1 = MagicMock()
        create_mock1.next_chunk.return_value = (None, {
            'id': 'rollback_part1_id',
            'name': 'fail_file.zip.gpart.001',
            'size': int(9.99 * 1024 * 1024 * 1024)
        })
        self.mock_service1.files.return_value.create.return_value = create_mock1

        # Service 2 create call will raise exception
        self.mock_service2.files.return_value.create.side_effect = Exception("Google API Error on Account 2")

        file_size = int(10.5 * 1024 * 1024 * 1024)
        mock_file = FileStorage(
            stream=ZeroStream(file_size),
            filename="fail_file.zip",
            content_type="application/zip"
        )

        with patch('drive_service.delete_file') as mock_delete:
            with patch('flask.Request.files', new_callable=PropertyMock) as mock_files_prop:
                mock_files_prop.return_value = {'file': mock_file}
                response = self.client.post('/api/upload', data={'folder_id': 'root'})

            self.assertEqual(response.status_code, 200)
            data = response.get_json()
            self.assertFalse(data['success'])
            self.assertIn('Gagal mengupload file', data['error'])
            
            mock_delete.assert_called_once()
            args, kwargs = mock_delete.call_args
            self.assertEqual(args[1], 'rollback_part1_id')

    def test_download_split_file_missing_account(self):
        db = SessionLocal()
        p1 = FileCache(
            file_id="part1_id_miss",
            name="split_file_miss.zip.gpart.001",
            mime_type="application/zip",
            size=1000,
            parent_id="root",
            account_id=999,
            user_id=1
        )
        db.add(p1)
        db.commit()
        db.close()

        response = self.client.get('/api/download/gpart:root:split_file_miss.zip')
        self.assertEqual(response.status_code, 400)
        data = response.get_json()
        self.assertIn('tidak dapat diakses atau telah dihapus', data['error'])


    def test_api_toggle_star_file(self):
        self.mock_service1.files().update().execute.return_value = {
            'id': 'file2',
            'starred': True
        }
        response = self.client.put('/api/files/star/file2?account_id=1', json={'starred': True})
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])
        self.assertTrue(data['starred'])
        
        db = SessionLocal()
        cached = db.query(FileCache).filter_by(file_id='file2').first()
        self.assertEqual(cached.is_starred, 1)
        db.close()

    def test_api_toggle_star_virtual_file(self):
        db = SessionLocal()
        p1 = FileCache(
            file_id="part1_id_star",
            name="split_file_star.zip.gpart.001",
            mime_type="application/zip",
            size=1000,
            parent_id="root",
            account_id=1,
            user_id=1,
            is_starred=0
        )
        p2 = FileCache(
            file_id="part2_id_star",
            name="split_file_star.zip.gpart.002",
            mime_type="application/zip",
            size=500,
            parent_id="root",
            account_id=2,
            user_id=1,
            is_starred=0
        )
        db.add(p1)
        db.add(p2)
        db.commit()
        db.close()

        self.mock_service1.files().update().execute.return_value = {'id': 'part1_id_star', 'starred': True}
        self.mock_service2.files().update().execute.return_value = {'id': 'part2_id_star', 'starred': True}

        response = self.client.put('/api/files/star/gpart:root:split_file_star.zip', json={'starred': True})
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])

        db = SessionLocal()
        parts = db.query(FileCache).filter(FileCache.name.like("split_file_star.zip.gpart.%")).all()
        self.assertEqual(len(parts), 2)
        for p in parts:
            self.assertEqual(p.is_starred, 1)
        db.close()

    def test_api_toggle_share_file(self):
        self.mock_service1.permissions().create().execute.return_value = {
            'id': 'perm_anyone_id'
        }
        response = self.client.put('/api/files/share/file2?account_id=1', json={'shared': True})
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])
        self.assertTrue(data['shared'])
        
        db = SessionLocal()
        cached = db.query(FileCache).filter_by(file_id='file2').first()
        self.assertEqual(cached.is_shared, 1)
        db.close()

        self.mock_service1.permissions().list().execute.return_value = {
            'permissions': [{'id': 'perm_anyone_id', 'type': 'anyone'}]
        }
        self.mock_service1.permissions().delete().execute.return_value = {}
        
        response = self.client.put('/api/files/share/file2?account_id=1', json={'shared': False})
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])
        self.assertFalse(data['shared'])

        db = SessionLocal()
        cached = db.query(FileCache).filter_by(file_id='file2').first()
        self.assertEqual(cached.is_shared, 0)
        db.close()

    def test_api_toggle_share_virtual_file(self):
        db = SessionLocal()
        p1 = FileCache(
            file_id="part1_id_share",
            name="split_file_share.zip.gpart.001",
            mime_type="application/zip",
            size=1000,
            parent_id="root",
            account_id=1,
            user_id=1,
            is_shared=0
        )
        p2 = FileCache(
            file_id="part2_id_share",
            name="split_file_share.zip.gpart.002",
            mime_type="application/zip",
            size=500,
            parent_id="root",
            account_id=2,
            user_id=1,
            is_shared=0
        )
        db.add(p1)
        db.add(p2)
        db.commit()
        db.close()

        self.mock_service1.permissions().create().execute.return_value = {'id': 'perm1'}
        self.mock_service2.permissions().create().execute.return_value = {'id': 'perm2'}

        response = self.client.put('/api/files/share/gpart:root:split_file_share.zip', json={'shared': True})
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])

        db = SessionLocal()
        parts = db.query(FileCache).filter(FileCache.name.like("split_file_share.zip.gpart.%")).all()
        self.assertEqual(len(parts), 2)
        for p in parts:
            self.assertEqual(p.is_shared, 1)
        db.close()


if __name__ == '__main__':
    unittest.main()
