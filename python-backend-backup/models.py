"""
models.py — Database models untuk Google Drive Aggregator.
Menggunakan SQLAlchemy + SQLite untuk menyimpan data akun, token, pengguna, dan cache file.
"""

import os
from sqlalchemy import create_engine, Column, Integer, String, Float, DateTime, ForeignKey
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.engine import Engine
from sqlalchemy.event import listens_for
import datetime
from dotenv import load_dotenv

load_dotenv()

# Render Postgres uses 'postgres://' but SQLAlchemy 1.4+ requires 'postgresql://'
raw_db_url = os.getenv("DATABASE_URL", "sqlite:///database.db")
if raw_db_url.startswith("postgres://"):
    raw_db_url = raw_db_url.replace("postgres://", "postgresql://", 1)

DATABASE_URL = raw_db_url

# Use connect_args to prevent thread issues in SQLite, not needed in Postgres
connect_args = {"check_same_thread": False} if "sqlite" in DATABASE_URL else {}

engine = create_engine(DATABASE_URL, echo=False, connect_args=connect_args)

# Aktifkan Foreign Key di SQLite secara otomatis
if "sqlite" in DATABASE_URL:
    @listens_for(Engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

SessionLocal = sessionmaker(bind=engine)
Base = declarative_base()


class User(Base):
    """Model untuk menyimpan data pengguna utama aplikasi (Multi-User)."""
    __tablename__ = 'users'

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String, unique=True, nullable=False, index=True)
    password_hash = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    def to_dict(self):
        """Konversi ke dictionary."""
        return {
            'id': self.id,
            'username': self.username,
            'created_at': self.created_at.isoformat() if self.created_at else None
        }


class Account(Base):
    """Model untuk menyimpan akun Google Drive yang terhubung."""
    __tablename__ = 'accounts'

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=True, index=True)    # Relasi ke User.id
    email = Column(String, nullable=False)                  # Email tidak lagi unik secara global (bisa dipakai user lain)
    display_name = Column(String, nullable=True)
    access_token = Column(String, nullable=True)
    refresh_token = Column(String, nullable=False)
    token_uri = Column(String, nullable=False)
    client_id = Column(String, nullable=False)
    client_secret = Column(String, nullable=False)
    quota_total = Column(Float, default=0)   # dalam bytes
    quota_used = Column(Float, default=0)    # dalam bytes
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    def to_dict(self):
        """Konversi ke dictionary untuk JSON response (tanpa data sensitif)."""
        return {
            'id': self.id,
            'user_id': self.user_id,
            'email': self.email,
            'display_name': self.display_name or self.email,
            'quota_total': self.quota_total,
            'quota_used': self.quota_used,
            'quota_free': self.quota_total - self.quota_used,
            'created_at': self.created_at.isoformat() if self.created_at else None
        }


class FileCache(Base):
    """Model untuk menyimpan cache metadata file Google Drive."""
    __tablename__ = 'file_cache'

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=True, index=True)      # Relasi ke User.id
    file_id = Column(String, index=True, nullable=False)      # ID Google Drive asli
    name = Column(String, nullable=False)
    mime_type = Column(String, nullable=False)
    size = Column(Float, default=0)
    modified_time = Column(String, nullable=True)             # ISO format date string
    parent_id = Column(String, index=True, nullable=False)      # ID Folder Induk asli
    account_id = Column(Integer, index=True, nullable=False)    # ID Akun relasi
    is_starred = Column(Integer, default=0)                     # 0 atau 1
    is_shared = Column(Integer, default=0)                      # 0 atau 1

    def to_dict(self):
        """Konversi ke dictionary untuk JSON response."""
        return {
            'id': self.file_id,
            'name': self.name,
            'mimeType': self.mime_type,
            'size': int(self.size) if self.size else 0,
            'modifiedTime': self.modified_time,
            'parent_id': self.parent_id,
            'account_id': self.account_id,
            'is_starred': bool(self.is_starred),
            'is_shared': bool(self.is_shared)
        }


def init_db():
    """Inisialisasi database — buat tabel jika belum ada dan lakukan migrasi kolom."""
    Base.metadata.create_all(engine)
    
    # Migrasi manual menggunakan SQLAlchemy
    from sqlalchemy import inspect, text
    inspector = inspect(engine)
    
    with engine.begin() as conn:
        try:
            # Cek kolom di tabel accounts
            if inspector.has_table('accounts'):
                columns = [col['name'] for col in inspector.get_columns('accounts')]
                if 'user_id' not in columns:
                    print("Migrasi: Menambahkan kolom 'user_id' ke tabel 'accounts'...")
                    conn.execute(text("ALTER TABLE accounts ADD COLUMN user_id INTEGER"))
                    
            # Cek kolom di tabel file_cache
            if inspector.has_table('file_cache'):
                columns = [col['name'] for col in inspector.get_columns('file_cache')]
                if 'user_id' not in columns:
                    print("Migrasi: Menambahkan kolom 'user_id' ke tabel 'file_cache'...")
                    conn.execute(text("ALTER TABLE file_cache ADD COLUMN user_id INTEGER"))
        except Exception as e:
            print(f"Gagal melakukan migrasi database: {e}")
            
    # Inisialisasi default user untuk versi standalone
    db = SessionLocal()
    try:
        default_user = db.query(User).filter_by(id=1).first()
        if not default_user:
            print("Membuat pengguna default lokal...")
            default_user = User(id=1, username="local_user", password_hash="")
            db.add(default_user)
            db.commit()
    except Exception as e:
        print(f"Gagal membuat pengguna default lokal: {e}")
        db.rollback()
    finally:
        db.close()
