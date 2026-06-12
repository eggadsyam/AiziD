import os

with open('app.py', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add JWT imports
import_str = '''from flask import (
    Flask, redirect, url_for, session, request,
    render_template, jsonify, send_file
)
from flask_jwt_extended import JWTManager, create_access_token, jwt_required, get_jwt_identity, verify_jwt_in_request'''
content = content.replace('from flask import (\n    Flask, redirect, url_for, session, request,\n    render_template, jsonify, send_file\n)', import_str)

# 2. Add JWT Config
config_str = '''app = Flask(__name__)
app.secret_key = 'gabungin-drive-aggregator-secret-key-2024'
app.config['JWT_SECRET_KEY'] = os.getenv('JWT_SECRET_KEY', 'super-secret-jwt-key')
jwt = JWTManager(app)'''
content = content.replace("app = Flask(__name__)\napp.secret_key = 'gabungin-drive-aggregator-secret-key-2024'", config_str)

# 3. Replace require_login
old_require = '''@app.before_request
def require_login():
    # Izinkan login, register, dan static files tanpa login
    if request.path.startswith('/static') or request.path in ['/login', '/register']:
        return
    if 'user_id' not in session:
        # Jika request API, return JSON 401
        if request.path.startswith('/api/'):
            return jsonify({'error': 'Unauthorized'}), 401
        return redirect(url_for('login'))

    # Verifikasi apakah user dengan id tersebut benar-benar ada di database
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=session['user_id']).first()
        if not user:
            session.clear()
            if request.path.startswith('/api/'):
                return jsonify({'error': 'Unauthorized'}), 401
            return redirect(url_for('login'))
    finally:
        db.close()'''

new_require = '''@app.before_request
def require_login():
    # Izinkan login, register, dan static files tanpa login
    if request.path.startswith('/static') or request.path in ['/login', '/register', '/api/auth/login', '/api/auth/register']:
        return

    # Check JWT first
    auth_header = request.headers.get('Authorization')
    if auth_header and auth_header.startswith('Bearer '):
        try:
            verify_jwt_in_request()
            request.user_id = int(get_jwt_identity())
        except Exception as e:
            return jsonify({'error': str(e)}), 401
    else:
        # Fallback to session
        if 'user_id' not in session:
            if request.path.startswith('/api/'):
                return jsonify({'error': 'Unauthorized'}), 401
            return redirect(url_for('login'))
        request.user_id = session['user_id']

    # Verifikasi apakah user dengan id tersebut benar-benar ada di database
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=request.user_id).first()
        if not user:
            session.clear()
            if request.path.startswith('/api/'):
                return jsonify({'error': 'Unauthorized'}), 401
            return redirect(url_for('login'))
    finally:
        db.close()'''
content = content.replace(old_require, new_require)

# 4. Replace session.get('user_id') with getattr(request, 'user_id', None)
content = content.replace("session.get('user_id')", "getattr(request, 'user_id', None)")

# Add auth routes before api/accounts
api_auth_str = '''
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
'''
content = content.replace("@app.route('/api/accounts')\n", api_auth_str)

with open('app.py', 'w', encoding='utf-8') as f:
    f.write(content)

print('app.py patched successfully')
