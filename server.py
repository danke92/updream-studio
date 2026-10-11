#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
NEXUS STAGE · 本地 AI 视频制作工作台
轻量本地服务：静态托管 + 归档 API + 媒体流 + updream 采集器桥接

启动: python server.py [--port 8788]
"""
import json, os, re, sys, time, uuid, hashlib, shutil, threading, webbrowser, socket
import http.server, socketserver, urllib.parse, mimetypes
from datetime import datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, 'web')
DATA = os.path.join(ROOT, 'data')
ACCOUNTS = os.path.join(DATA, 'accounts')      # 每个手机号 = 一个完全独立的素材库
ACC_INDEX = os.path.join(DATA, 'accounts.json')

for d in (DATA, ACCOUNTS):
    os.makedirs(d, exist_ok=True)

PORT = int(next((a for a in sys.argv[1:] if a.isdigit()), 8788))

# ---------------- 缩略图（Pillow 可选） ----------------
try:
    from PIL import Image
    HAS_PIL = True
except Exception:
    HAS_PIL = False

IMG_EXT = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff'}
VID_EXT = {'.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.flv'}
TXT_EXT = {'.txt', '.md', '.json', '.csv', '.yml', '.yaml', '.srt'}


def now_ms():
    return int(time.time() * 1000)


def uid():
    return uuid.uuid4().hex[:12]


def safe_name(s):
    return re.sub(r'[\\/:*?"<>|\r\n]+', '_', (s or '').strip())[:80] or 'untitled'


# ============================================================
#  账户 · 每个手机号一套独立素材库
# ============================================================
DEFAULT_PHONE = '000000'          # 旧版本单库迁移到此默认账户


def phone_key(p):
    return re.sub(r'\D', '', str(p or ''))


def is_phone(p):
    return bool(re.match(r'^\d{4,20}$', phone_key(p)))


class Account(object):
    """一个手机号 = 一个账户 = 一套独立的 library / assets / thumbs / 浏览器配置"""

    def __init__(self, phone, name='', created_at=None):
        self.phone = phone
        self.name = name or ''
        self.createdAt = created_at or now_ms()
        self.lastAt = now_ms()
        self.dir = os.path.join(ACCOUNTS, 'u' + phone)
        self.assets = os.path.join(self.dir, 'assets')
        self.thumbs = os.path.join(self.dir, 'thumbs')
        self.profile = os.path.join(self.dir, 'browser-profile')
        self.lib_path = os.path.join(self.dir, 'library.json')
        for d in (self.dir, self.assets, self.thumbs):
            os.makedirs(d, exist_ok=True)
        self.lock = threading.Lock()
        self.lib = self._load()
        # 各平台的采集器（updream / libtv），彼此独立浏览器配置与状态
        self.collectors = {'updream': None, 'libtv': None}
        self.cstates = {
            k: {'running': False, 'logged': False, 'msg': '未启动', 'last': 0, 'count': 0}
            for k in ('updream', 'libtv')
        }

    @property
    def collector(self):
        return self.collectors.get('updream')

    @property
    def cstate(self):
        return self.cstates['updream']

    # ---------- 归档库读写 ----------
    def _load(self):
        if not os.path.exists(self.lib_path):
            return {"version": 1, "assets": [], "projects": [], "updatedAt": now_ms()}
        try:
            with open(self.lib_path, 'r', encoding='utf-8') as f:
                d = json.load(f)
            d.setdefault('assets', [])
            d.setdefault('projects', [])
            return d
        except Exception as e:
            print('[warn] %s 读取失败，使用空库: %s' % (self.lib_path, e))
            return {"version": 1, "assets": [], "projects": [], "updatedAt": now_ms()}

    def save(self, _lib=None):
        """保存归档库；_lib 仅为兼容采集器回调签名"""
        self.lib['updatedAt'] = now_ms()
        tmp = self.lib_path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(self.lib, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.lib_path)

    def thumb(self, src_path, out_id):
        return make_thumb(src_path, out_id, self.thumbs)

    def close(self):
        """退出 / 切换账户时释放所有浏览器"""
        for k, c in self.collectors.items():
            if c is not None:
                try:
                    c.close()
                except Exception:
                    pass
                self.collectors[k] = None
            self.cstates[k].update(running=False, logged=False, msg='未启动')

    def info(self):
        return {
            'phone': self.phone,
            'name': self.name or ('用户 ' + self.phone[-4:]),
            'createdAt': self.createdAt,
            'lastAt': self.lastAt,
            'count': len(self.lib['assets']),
            'size': sum((a.get('size') or 0) for a in self.lib['assets']),
        }


_ACC = {}                 # phone -> Account
_ACC_LOCK = threading.Lock()
SESSIONS = {}             # token -> phone


def load_accounts():
    if os.path.exists(ACC_INDEX):
        try:
            with open(ACC_INDEX, 'r', encoding='utf-8') as f:
                idx = json.load(f)
            for it in idx.get('accounts', []):
                p = phone_key(it.get('phone'))
                if p:
                    _ACC[p] = Account(p, it.get('name', ''), it.get('createdAt'))
        except Exception as e:
            print('[warn] accounts.json 读取失败:', e)
    return _ACC


def save_accounts():
    tmp = ACC_INDEX + '.tmp'
    data = {'version': 1, 'accounts': [
        {'phone': a.phone, 'name': a.name, 'createdAt': a.createdAt, 'lastAt': a.lastAt}
        for a in sorted(_ACC.values(), key=lambda x: -x.lastAt)
    ]}
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, ACC_INDEX)


def get_account(phone, create=False, name=''):
    p = phone_key(phone)
    if not p:
        return None
    with _ACC_LOCK:
        a = _ACC.get(p)
        if a is None and create:
            a = Account(p, name)
            _ACC[p] = a
            save_accounts()
        if a is not None:
            a.lastAt = now_ms()
            if name and not a.name:
                a.name = name
                save_accounts()
        return a


def migrate_legacy():
    """旧版本（单库）数据 → 默认账户，保证历史资产不丢"""
    old_lib = os.path.join(DATA, 'library.json')
    if not os.path.exists(old_lib) or _ACC:
        return None
    acc = Account(DEFAULT_PHONE, '本机默认库')
    try:
        shutil.move(old_lib, acc.lib_path)
    except Exception:
        try:
            shutil.copy(old_lib, acc.lib_path)
        except Exception:
            pass
    pairs = ((os.path.join(DATA, 'assets'), acc.assets),
             (os.path.join(DATA, 'thumbs'), acc.thumbs),
             (os.path.join(DATA, 'browser-profile'), acc.profile))
    for src, dst in pairs:
        if os.path.isdir(src):
            for fn in os.listdir(src):
                try:
                    shutil.move(os.path.join(src, fn), os.path.join(dst, fn))
                except Exception:
                    pass
    acc.lib = acc._load()
    _ACC[DEFAULT_PHONE] = acc
    save_accounts()
    print('[迁移] 原有归档库已归入「本机默认库」(%s)，共 %d 项' % (DEFAULT_PHONE, len(acc.lib['assets'])))
    return acc


load_accounts()
migrate_legacy()


# ============================================================
#  自动归类规则
# ============================================================
CHAR_WORDS = ['三视图', '多视角', '正面', '侧面', '背面', '背面', 'front', 'side', 'back',
              'turnaround', 'character', '角色', '人物', '人设', '造型']
VIEW_MAP = [
    ('front', ['正面', 'front', '正视图', '前视']),
    ('side', ['侧面', '侧视', 'side', 'profile']),
    ('back', ['背面', '背视', 'back', '后视']),
    ('three', ['三视图', '多视角', 'turnaround', '合图', '拼图']),
]
BLOCK_WORDS = ['白模', '灰模', 'blockout', 'block out', 'graybox', 'greybox', '未贴图', '素模', 'layout', 'layout图']
RENDER_WORDS = ['效果图', '渲染', 'render', '成品', 'final', '材质', '打光', 'lighting', '氛围图', '定稿']
SEQ_WORDS = ['分镜', '镜头', 'shot', 'storyboard', '片段', 'clip', 'cut', '第', '场']
FINAL_WORDS = ['成片', '正片', 'export', '导出', 'final cut', '成稿', '母版']
SCRIPT_WORDS = ['剧本', '脚本', 'script', '提示词', 'prompt', '对白', '台词', '大纲']


def detect_view(text):
    for v, keys in VIEW_MAP:
        for k in keys:
            if k in text:
                return v
    return ''


def classify(name, prompt='', url=''):
    """返回 (kind, view, stage)"""
    t = (name + ' ' + prompt + ' ' + url).lower()
    if any(k in t for k in SCRIPT_WORDS) and not any(e in t for e in ['.png', '.jpg', '.mp4']):
        pass
    # 1) 人物三视图优先
    if any(k in t for k in CHAR_WORDS):
        return 'character', detect_view(t), ''
    # 2) 场景白模 / 效果图
    if any(k in t for k in BLOCK_WORDS):
        return 'scene', '', 'blockout'
    if any(k in t for k in RENDER_WORDS):
        return 'scene', '', 'render'
    if '场景' in t or 'scene' in t or 'set' in t:
        return 'scene', '', ''
    # 3) 连续内容 / 分镜片段
    if any(k in t for k in SEQ_WORDS):
        return 'sequence', '', ''
    if any(k in t for k in FINAL_WORDS):
        return 'final', '', ''
    if any(k in t for k in SCRIPT_WORDS):
        return 'script', '', ''
    return 'other', '', ''


NUM_RE = {
    'episode': re.compile(r'(?:ep|e|第|集)\s*(\d{1,3})', re.I),
    'shot': re.compile(r'(?:shot|s|镜|镜头|分镜)\s*(\d{1,3})', re.I),
    'version': re.compile(r'(?:v|ver|版本)\s*(\d{1,2})', re.I),
}


def extract_nums(text):
    out = {}
    for k, r in NUM_RE.items():
        m = r.search(text or '')
        if m:
            out[k] = int(m.group(1))
    return out


def make_thumb(src_path, out_id, thumbs_dir):
    if not HAS_PIL:
        return None
    try:
        os.makedirs(thumbs_dir, exist_ok=True)
        with Image.open(src_path) as im:
            im = im.convert('RGB')
            im.thumbnail((520, 520))
            p = os.path.join(thumbs_dir, out_id + '.jpg')
            im.save(p, 'JPEG', quality=82)
            return 'thumbs/' + out_id + '.jpg'
    except Exception:
        return None


def file_md5(path, limit=1 << 20):
    h = hashlib.md5()
    try:
        with open(path, 'rb') as f:
            h.update(f.read(limit))
    except Exception:
        pass
    return h.hexdigest()


# ============================================================
#  资产构造
# ============================================================
def new_asset(**kw):
    a = {
        'id': uid(),
        'kind': 'other',
        'title': '',
        'project': '',
        'role': '',        # 人物角色名
        'view': '',        # front / side / back / three
        'scene': '',       # 场景名
        'stage': '',       # blockout / render
        'series': '',      # 连续内容系列
        'episode': None,
        'shot': None,
        'version': 1,
        'tags': [],
        'prompt': '',
        'model': '',
        'source': 'manual',  # manual / scan / updream / upload
        'sourceUrl': '',
        'file': '',          # data 下相对路径
        'path': '',          # 扫描到的绝对路径
        'thumb': '',
        'mime': '',
        'size': 0,
        'w': 0, 'h': 0,
        'note': '',
        'createdAt': now_ms(),
        'updatedAt': now_ms(),
    }
    a.update({k: v for k, v in kw.items() if v not in (None, '') or k in ('episode', 'shot', 'version')})
    return a


def guess_kind_by_ext(ext):
    if ext in VID_EXT:
        return 'sequence'
    if ext in TXT_EXT:
        return 'script'
    return 'other'


# ============================================================
#  分组视图（供可视化）
# ============================================================
def build_groups(assets):
    chars, scenes, seqs = {}, {}, {}

    for a in assets:
        if a['kind'] == 'character':
            key = (a.get('project', ''), a.get('role') or re.sub(r'[_\-\s]*(正面|侧面|背面|front|side|back|三视图).*$', '', a.get('title', ''), flags=re.I) or a.get('title', ''))
            g = chars.setdefault(key, {
                'key': '|'.join(key), 'project': a.get('project', ''),
                'role': a.get('role') or (key[1] or '未命名角色'),
                'views': {}, 'items': [], 'updatedAt': 0
            })
            v = a.get('view') or 'other'
            g['views'].setdefault(v, a)
            g['items'].append(a)
            g['updatedAt'] = max(g['updatedAt'], a.get('updatedAt', 0))

        elif a['kind'] == 'scene':
            key = (a.get('project', ''), a.get('scene') or re.sub(r'[_\-\s]*(白模|效果图|渲染|blockout|render).*$', '', a.get('title', ''), flags=re.I) or a.get('title', ''))
            g = scenes.setdefault(key, {
                'key': '|'.join(key), 'project': a.get('project', ''),
                'scene': a.get('scene') or (key[1] or '未命名场景'),
                'stages': {}, 'items': [], 'updatedAt': 0
            })
            st = a.get('stage') or 'other'
            g['stages'].setdefault(st, [])
            g['stages'][st].append(a)
            g['items'].append(a)
            g['updatedAt'] = max(g['updatedAt'], a.get('updatedAt', 0))

        elif a['kind'] in ('sequence', 'final'):
            s = a.get('series') or a.get('project') or '未分组序列'
            g = seqs.setdefault(s, {
                'key': s, 'series': s, 'project': a.get('project', ''),
                'shots': [], 'updatedAt': 0
            })
            g['shots'].append(a)
            g['updatedAt'] = max(g['updatedAt'], a.get('updatedAt', 0))

    for g in seqs.values():
        g['shots'].sort(key=lambda a: ((a.get('episode') or 0), (a.get('shot') or 0), a.get('createdAt', 0)))
    return (
        sorted(chars.values(), key=lambda g: -g['updatedAt']),
        sorted(scenes.values(), key=lambda g: -g['updatedAt']),
        sorted(seqs.values(), key=lambda g: -g['updatedAt']),
    )


def build_stats(assets):
    by_kind, by_source, by_day = {}, {}, {}
    total = 0
    for a in assets:
        by_kind[a['kind']] = by_kind.get(a['kind'], 0) + 1
        by_source[a.get('source', 'manual')] = by_source.get(a.get('source', 'manual'), 0) + 1
        total += a.get('size', 0) or 0
        d = datetime.fromtimestamp((a.get('createdAt') or now_ms()) / 1000).strftime('%m-%d')
        by_day[d] = by_day.get(d, 0) + 1
    days = []
    for i in range(13, -1, -1):
        d = datetime.fromtimestamp(time.time() - i * 86400).strftime('%m-%d')
        days.append({'day': d, 'n': by_day.get(d, 0)})
    return {
        'total': len(assets),
        'size': total,
        'byKind': by_kind,
        'bySource': by_source,
        'trend': days,
    }


# ============================================================
#  扫描本地目录
# ============================================================
def scan_dir(acc, target):
    """扫描目录，媒体文件纳入归档（不复制，仅记录绝对路径）"""
    added = []
    if not os.path.isdir(target):
        return added, '目录不存在: %s' % target
    exist = {a.get('path') for a in acc.lib['assets']}
    for root, dirs, files in os.walk(target):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for fn in files:
            ext = os.path.splitext(fn)[1].lower()
            if ext not in IMG_EXT | VID_EXT | TXT_EXT:
                continue
            p = os.path.join(root, fn)
            if p in exist:
                continue
            try:
                sz = os.path.getsize(p)
            except Exception:
                continue
            kind, view, stage = classify(fn)
            if kind == 'other':
                kind = guess_kind_by_ext(ext)
            nums = extract_nums(fn)
            a = new_asset(
                kind=kind, title=os.path.splitext(fn)[0],
                project=os.path.basename(target), view=view, stage=stage,
                episode=nums.get('episode'), shot=nums.get('shot'),
                version=nums.get('version', 1),
                source='scan', path=p, size=sz,
                mime=mimetypes.guess_type(p)[0] or '',
            )
            if ext in IMG_EXT and HAS_PIL:
                t = acc.thumb(p, a['id'])
                if t:
                    a['thumb'] = t
                    try:
                        with Image.open(p) as im:
                            a['w'], a['h'] = im.size
                    except Exception:
                        pass
            added.append(a)
    with acc.lock:
        acc.lib['assets'].extend(added)
        if added:
            acc.save()
    return added, ''


# ============================================================
#  采集器桥接（按账户独立：每账户独立浏览器配置与状态）
# ============================================================
COLLECTOR_MODULES = {
    'updream': ('collect_updream', 'Collector'),
    'libtv': ('collect_libtv', 'LibTVCollector'),
}


def get_collector(acc, src='updream'):
    """按平台取（或创建）采集器；每个平台独立的浏览器配置目录"""
    src = src if src in COLLECTOR_MODULES else 'updream'
    if acc.collectors.get(src) is None:
        sys.path.insert(0, os.path.join(ROOT, 'tools'))
        mod_name, cls_name = COLLECTOR_MODULES[src]
        try:
            mod = __import__(mod_name)
            cls = getattr(mod, cls_name)
            # 每个平台一个浏览器配置目录，避免登录态互相覆盖
            profile = acc.profile if src == 'updream' else acc.profile + '-' + src
            acc.collectors[src] = cls(
                profile, acc.assets, acc.lib, acc.lock,
                acc.save, new_asset, classify, acc.thumb,
            )
        except Exception as e:
            acc.cstates[src]['msg'] = '采集器不可用: %s' % e
            return None
    return acc.collectors[src]


# ============================================================
#  HTTP 处理
# ============================================================
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200, headers=None):
        b = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(b)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n) if n else b''

    def _q(self):
        return urllib.parse.parse_qs(urllib.parse.urlparse(self._norm()).query)

    def _norm(self):
        """请求行按 latin-1 解码，这里还原为中文（兼容未做 percent-encode 的客户端）"""
        try:
            return self.path.encode('latin-1', 'ignore').decode('utf-8')
        except Exception:
            return self.path

    # ---------- 会话 ----------
    def _cookie(self, name):
        raw = self.headers.get('Cookie') or ''
        for part in raw.split(';'):
            k, _, v = part.partition('=')
            if k.strip() == name:
                return urllib.parse.unquote(v.strip())
        return ''

    def _acc(self):
        """当前登录账户（None = 未登录）"""
        tok = self._cookie('ns_session')
        phone = SESSIONS.get(tok)
        if not phone:
            return None
        with _ACC_LOCK:
            return _ACC.get(phone)

    def need_acc(self):
        a = self._acc()
        if a is None:
            self._json({'ok': False, 'error': '未登录', 'code': 401}, 401)
            return None
        return a

    # ---------- GET ----------
    def do_GET(self):
        p = urllib.parse.urlparse(self._norm()).path

        if p == '/':
            self.path = '/index.html'
            return super().do_GET()

        # === 账户 / 登录 ===
        if p == '/api/auth/me':
            a = self._acc()
            return self._json({
                'ok': a is not None,
                'user': a.info() if a else None,
                'accounts': [x.info() for x in sorted(_ACC.values(), key=lambda v: -v.lastAt)],
            })

        if p == '/api/auth/check':
            ph = phone_key(self._q().get('phone', [''])[0])
            with _ACC_LOCK:
                a = _ACC.get(ph)
            return self._json({'ok': True, 'phone': ph, 'valid': is_phone(ph),
                               'exists': a is not None, 'info': a.info() if a else None})

        if p == '/api/auth/logout':
            tok = self._cookie('ns_session')
            ph = SESSIONS.pop(tok, None)
            if ph:
                with _ACC_LOCK:
                    a = _ACC.get(ph)
                if a:
                    a.close()
            return self._json({'ok': True}, headers={'Set-Cookie': 'ns_session=; Path=/; Max-Age=0'})

        # === 以下接口均需登录 ===
        if p == '/api/library':
            acc = self.need_acc()
            if not acc:
                return
            with acc.lock:
                assets = list(acc.lib['assets'])
            chars, scenes, seqs = build_groups(assets)
            return self._json({
                'user': acc.info(),
                'assets': sorted(assets, key=lambda a: -a.get('updatedAt', 0)),
                'characters': chars, 'scenes': scenes, 'sequences': seqs,
                'projects': acc.lib.get('projects', []),
                'stats': build_stats(assets),
                'collector': dict(acc.cstates['updream']),
                'libtv': dict(acc.cstates['libtv']),
                'pillow': HAS_PIL,
            })

        if p == '/api/collect/status':
            acc = self.need_acc()
            if not acc:
                return
            for k, c in acc.collectors.items():
                st = acc.cstates[k]
                if c:
                    st['running'] = bool(c.running)          # 同步浏览器真实存活状态
                    if not c.running and st['msg'] and '登录' in st['msg']:
                        st['msg'] = '浏览器已关闭'
            return self._json({
                'collector': dict(acc.cstates['updream']),   # 兼容旧字段
                'libtv': dict(acc.cstates['libtv']),
                'collectors': {k: dict(v) for k, v in acc.cstates.items()},
            })

        if p == '/media':
            acc = self.need_acc()
            if not acc:
                return
            return self.serve_media(acc, self._q().get('id', [''])[0])

        if p == '/file':
            acc = self.need_acc()
            if not acc:
                return
            rel = urllib.parse.unquote(self._q().get('p', [''])[0])
            fp = os.path.normpath(os.path.join(acc.dir, rel))
            if not fp.startswith(acc.dir) or not os.path.exists(fp):
                self.send_error(404)
                return
            return self.send_file(fp)

        if p == '/api/env':
            home = os.path.expanduser('~')
            return self._json({
                'home': home,
                'downloads': os.path.join(home, 'Downloads'),
                'desktop': os.path.join(home, 'Desktop'),
                'cwd': ROOT,
            })

        return super().do_GET()

    # ---------- POST ----------
    def do_POST(self):
        p = urllib.parse.urlparse(self._norm()).path
        q = self._q()
        body = self._body()

        # === 登录 / 账户管理 ===
        if p == '/api/auth/login':
            try:
                d = json.loads(body.decode('utf-8') or b'{}')
            except Exception:
                d = {}
            ph = phone_key(d.get('phone', ''))
            if not is_phone(ph):
                return self._json({'ok': False, 'msg': '请输入有效的手机号'}, 400)
            acc = get_account(ph, create=True, name=(d.get('name') or '').strip())
            if acc is None:
                return self._json({'ok': False, 'msg': '登录失败'}, 400)
            tok = uuid.uuid4().hex + uuid.uuid4().hex[:8]
            SESSIONS[tok] = acc.phone
            return self._json(
                {'ok': True, 'user': acc.info(), 'isNew': len(acc.lib['assets']) == 0 and acc.createdAt >= now_ms() - 3000},
                headers={'Set-Cookie': 'ns_session=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d' % (tok, 60 * 60 * 24 * 30)},
            )

        if p == '/api/auth/rename':
            acc = self.need_acc()
            if not acc:
                return
            try:
                d = json.loads(body.decode('utf-8') or b'{}')
            except Exception:
                d = {}
            nm = (d.get('name') or '').strip()[:24]
            if nm:
                acc.name = nm
                save_accounts()
            return self._json({'ok': True, 'user': acc.info()})

        if p == '/api/auth/delete':
            """销毁当前账户及其全部素材（不可恢复）"""
            acc = self.need_acc()
            if not acc:
                return
            try:
                d = json.loads(body.decode('utf-8') or b'{}')
            except Exception:
                d = {}
            if phone_key(d.get('phone', '')) != acc.phone:
                return self._json({'ok': False, 'msg': '手机号不匹配，已取消'}, 400)
            tok = self._cookie('ns_session')
            SESSIONS.pop(tok, None)
            acc.close()
            with _ACC_LOCK:
                _ACC.pop(acc.phone, None)
            save_accounts()
            try:
                shutil.rmtree(acc.dir, ignore_errors=True)
            except Exception:
                pass
            return self._json({'ok': True}, headers={'Set-Cookie': 'ns_session=; Path=/; Max-Age=0'})

        # === 以下接口均需登录 ===
        if p == '/api/assets':
            acc = self.need_acc()
            if not acc:
                return
            try:
                d = json.loads(body.decode('utf-8'))
            except Exception:
                return self._json({'error': 'bad json'}, 400)
            a = new_asset(**{k: v for k, v in d.items() if k in new_asset()})
            if not a.get('title'):
                return self._json({'error': '缺少标题'}, 400)
            with acc.lock:
                acc.lib['assets'].append(a)
                acc.save()
            return self._json({'ok': True, 'asset': a})

        if p == '/api/upload':
            acc = self.need_acc()
            if not acc:
                return
            return self.handle_upload(acc, q, body)

        if p == '/api/scan':
            acc = self.need_acc()
            if not acc:
                return
            try:
                d = json.loads(body.decode('utf-8') or b'{}')
            except Exception:
                d = {}
            added, err = scan_dir(acc, d.get('dir', ''))
            return self._json({'ok': not err, 'error': err, 'added': len(added)})

        # 采集接口：/api/collect/<action> → updream；/api/libtv/<action> → libtv
        if p.startswith('/api/collect/') or p.startswith('/api/libtv/'):
            acc = self.need_acc()
            if not acc:
                return
            src = 'libtv' if p.startswith('/api/libtv/') else 'updream'
            act = p.rsplit('/', 1)[-1]
            return self.collect_action(acc, src, act, body)

        if p == '/api/demo':
            acc = self.need_acc()
            if not acc:
                return
            n = load_demo(acc)
            return self._json({'ok': True, 'added': n})

        if p == '/api/wipe':
            acc = self.need_acc()
            if not acc:
                return
            with acc.lock:
                acc.lib['assets'] = []
                acc.save()
            return self._json({'ok': True})

        if p == '/api/open':
            try:
                d = json.loads(body.decode('utf-8') or b'{}')
            except Exception:
                d = {}
            t = d.get('path', '')
            if t and os.path.exists(t):
                try:
                    os.startfile(t)
                except Exception:
                    pass
            return self._json({'ok': True})

        if p.startswith('/api/assets/'):
            acc = self.need_acc()
            if not acc:
                return
            parts = p.strip('/').split('/')      # api/assets/<id>/<action>
            if len(parts) == 4 and parts[1] == 'assets':
                if parts[3] == 'update':
                    return self.update_asset(acc, parts[2], body)
                if parts[3] == 'delete':
                    return self.delete_asset(acc, parts[2])

        return self._json({'error': 'not found'}, 404)

    def do_PATCH(self):
        self.do_POST()

    def collect_action(self, acc, src, act, body):
        """平台采集动作：start / capture / goto / shot / stop"""
        st = acc.cstates[src]
        label = 'LibTV' if src == 'libtv' else 'updream'

        if act == 'start':
            c = get_collector(acc, src)
            if not c:
                return self._json({'ok': False, 'msg': st['msg']})
            try:
                c.open_login()
                ok = bool(c.running)
                st.update(
                    running=ok, logged=False,
                    msg=(c.error or ('浏览器已打开，请在窗口中登录 %s' % label if ok else '浏览器启动失败'))
                )
            except Exception as e:
                st.update(running=False, msg='启动失败: %s' % e)
                return self._json({'ok': False, 'msg': st['msg']})
            return self._json({'ok': bool(st['running']), 'msg': st['msg']})

        c = acc.collectors.get(src)
        if act != 'stop' and (not c or not st['running']):
            return self._json({'ok': False, 'msg': '采集器未运行'})

        if act == 'capture':
            try:
                n = c.capture_current()
                st['count'] += n
                st['msg'] = '本次采集 %d 项' % n
                return self._json({'ok': True, 'added': n, 'msg': st['msg']})
            except Exception as e:
                st['msg'] = '采集失败: %s' % e
                return self._json({'ok': False, 'msg': st['msg']})

        if act == 'goto':
            try:
                d = json.loads(body.decode('utf-8') or b'{}')
                info = c.goto(d)
                return self._json({'ok': True, 'info': info})
            except Exception as e:
                return self._json({'ok': False, 'msg': '导航失败: %s' % e})

        if act == 'shot':
            try:
                fp = os.path.join(acc.dir, '%s-shot.png' % src)
                c.screenshot(fp)
                return self._json({'ok': True, 'file': '%s-shot.png' % src, 't': int(time.time() * 1000)})
            except Exception as e:
                return self._json({'ok': False, 'msg': '截图失败: %s' % e})

        if act == 'stop':
            if c:
                c.close()
            acc.collectors[src] = None
            st.update(running=False, logged=False, msg='已断开')
            return self._json({'ok': True})

        return self._json({'error': 'not found'}, 404)

    def update_asset(self, acc, aid, body):
        try:
            d = json.loads(body.decode('utf-8'))
        except Exception:
            return self._json({'error': 'bad json'}, 400)
        with acc.lock:
            for a in acc.lib['assets']:
                if a['id'] == aid:
                    for k, v in d.items():
                        if k in ('id', 'createdAt'):
                            continue
                        a[k] = v
                    a['updatedAt'] = now_ms()
                    acc.save()
                    return self._json({'ok': True, 'asset': a})
        return self._json({'error': 'not found'}, 404)

    def delete_asset(self, acc, aid):
        with acc.lock:
            n = len(acc.lib['assets'])
            acc.lib['assets'] = [a for a in acc.lib['assets'] if a['id'] != aid]
            if len(acc.lib['assets']) != n:
                acc.save()
                for ext in IMG_EXT | VID_EXT:
                    fp = os.path.join(acc.assets, aid + ext)
                    if os.path.exists(fp):
                        try:
                            os.remove(fp)
                        except Exception:
                            pass
                tp = os.path.join(acc.thumbs, aid + '.jpg')
                if os.path.exists(tp):
                    try:
                        os.remove(tp)
                    except Exception:
                        pass
                return self._json({'ok': True})
        return self._json({'error': 'not found'}, 404)

    def handle_upload(self, acc, q, body):
        """原始字节上传，元数据放 query"""
        if not body:
            return self._json({'error': '空文件'}, 400)
        name = urllib.parse.unquote(q.get('name', ['asset'])[0])
        ext = os.path.splitext(name)[1].lower()
        aid = uid()
        fn = aid + (ext or '.bin')
        fp = os.path.join(acc.assets, fn)
        with open(fp, 'wb') as f:
            f.write(body)
        kind = q.get('kind', [''])[0] or guess_kind_by_ext(ext)
        if kind == 'other':
            k, v, s = classify(name)
            kind, view, stage = (k, v, s) if k != 'other' else (guess_kind_by_ext(ext), '', '')
        else:
            view = q.get('view', [''])[0]
            stage = q.get('stage', [''])[0]
        thumb = acc.thumb(fp, aid) if ext in IMG_EXT else None
        nums = extract_nums(name)
        a = new_asset(
            kind=kind, title=q.get('title', [os.path.splitext(name)[0]])[0],
            project=urllib.parse.unquote(q.get('project', [''])[0]),
            role=urllib.parse.unquote(q.get('role', [''])[0]),
            view=view, stage=stage,
            scene=urllib.parse.unquote(q.get('scene', [''])[0]),
            series=urllib.parse.unquote(q.get('series', [''])[0]),
            episode=nums.get('episode'), shot=nums.get('shot'), version=nums.get('version', 1),
            tags=[t for t in urllib.parse.unquote(q.get('tags', [''])[0]).split(',') if t],
            prompt=urllib.parse.unquote(q.get('prompt', [''])[0]),
            model=urllib.parse.unquote(q.get('model', [''])[0]),
            source='upload', file='assets/' + fn, thumb=thumb or '',
            mime=mimetypes.guess_type(name)[0] or '', size=len(body),
        )
        if ext in IMG_EXT and HAS_PIL:
            try:
                with Image.open(fp) as im:
                    a['w'], a['h'] = im.size
            except Exception:
                pass
        with acc.lock:
            acc.lib['assets'].append(a)
            acc.save()
        return self._json({'ok': True, 'asset': a})

    # ---------- 媒体（支持 Range） ----------
    def serve_media(self, acc, aid):
        with acc.lock:
            a = next((x for x in acc.lib['assets'] if x['id'] == aid), None)
        if not a:
            self.send_error(404)
            return
        fp = a.get('path') or (os.path.join(acc.dir, a['file']) if a.get('file') else '')
        if not fp or not os.path.exists(fp):
            self.send_error(404)
            return
        mt = a.get('mime') or mimetypes.guess_type(fp)[0] or 'application/octet-stream'
        return self.send_file(fp, mt)

    def send_file(self, fp, mt=None):
        mt = mt or mimetypes.guess_type(fp)[0] or 'application/octet-stream'
        size = os.path.getsize(fp)
        rng = self.headers.get('Range')
        start, end = 0, size - 1
        code = 200
        if rng:
            m = re.match(r'bytes=(\d*)-(\d*)', rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                if m.group(2):
                    end = int(m.group(2))
                code = 206
        with open(fp, 'rb') as f:
            if start:
                f.seek(start)
            data = f.read(max(0, end - start + 1))
        self.send_response(code)
        self.send_header('Content-Type', mt)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Accept-Ranges', 'bytes')
        if code == 206:
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.send_header('Cache-Control', 'public, max-age=86400')
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass


# ============================================================
#  演示数据
# ============================================================
def load_demo(acc):
    """生成一套演示归档（无实体文件，仅元数据 + 占位图）"""
    demo = []
    proj = '《雾港迷航》第一季'
    # 人物三视图
    for role, tag in [('林渡', '主角'), ('苏禾', '女主角'), ('老陈', '配角')]:
        for view, vn in [('front', '正面'), ('side', '侧面'), ('back', '背面')]:
            demo.append(dict(kind='character', title='%s-%s视图' % (role, vn), project=proj,
                             role=role, view=view, tags=[tag, '三视图'],
                             prompt='%s, %s view, turnaround sheet, consistent design, neutral lighting' % (role, view),
                             model='Seedance 2.5', source='updream'))
    # 场景白模与效果图
    for sc in ['雾港码头', '老灯塔内部', '雨夜巷道']:
        demo.append(dict(kind='scene', title='%s-白模' % sc, project=proj, scene=sc, stage='blockout',
                         tags=['白模', 'layout'], prompt='%s, blockout, gray clay render, no texture' % sc,
                         model='Gimage', source='updream'))
        demo.append(dict(kind='scene', title='%s-效果图' % sc, project=proj, scene=sc, stage='render',
                         tags=['效果图', '定稿'], prompt='%s, final render, volumetric fog, cinematic' % sc,
                         model='Gimage', source='updream'))
    # 连续内容
    for ep in range(1, 3):
        for shot in range(1, 5):
            demo.append(dict(kind='sequence', title='EP%d-SHOT%02d 片段' % (ep, shot), project=proj,
                             series='雾港迷航', episode=ep, shot=shot, version=1,
                             tags=['分镜', 'EP%d' % ep],
                             prompt='shot %d of episode %d, camera push in, rain, handheld' % (shot, ep),
                             model='Seedance 2.5', source='updream'))
    demo.append(dict(kind='final', title='EP01 成片 v2', project=proj, series='雾港迷航',
                     episode=1, version=2, tags=['成片'], model='Seedance 2.5', source='updream'))
    demo.append(dict(kind='script', title='EP01 剧本与提示词', project=proj, tags=['剧本'],
                     prompt='雨夜，林渡在码头等待一艘不会到来的船……', source='updream'))

    added = 0
    with acc.lock:
        for d in demo:
            if any(a.get('title') == d['title'] and a.get('project') == d.get('project') for a in acc.lib['assets']):
                continue
            acc.lib['assets'].append(new_asset(**d))
            added += 1
        if added:
            acc.save()
    return added


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def lan_ip():
    """探测本机在局域网中的 IP（用于其它设备访问）"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('223.5.5.5', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return ''


def main():
    url = 'http://127.0.0.1:%d/' % PORT
    lan = lan_ip()
    print('=' * 58)
    print('  NEXUS STAGE · 本地 AI 视频制作工作台')
    print('  账户目录: %s' % ACCOUNTS)
    print('  已有账户: %d 个 %s' % (len(_ACC), '、'.join(a.info()['name'] + '(' + a.phone + ')' for a in list(_ACC.values())[:5])))
    print('  本机访问: %s' % url)
    if lan and not lan.startswith('127.'):
        print('  其它设备: http://%s:%d/   （同一 WiFi / 局域网）' % (lan, PORT))
        print('           连不上就先双击 allow-lan.bat 放行防火墙')
    print('  监听:     0.0.0.0:%d' % PORT)
    print('=' * 58)
    try:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    except Exception:
        pass
    with ThreadedHTTPServer(('0.0.0.0', PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n已停止')


if __name__ == '__main__':
    main()
