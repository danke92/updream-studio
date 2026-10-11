#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
updream 采集器
- 由「用户本人」在自动化浏览器中完成登录（脚本不接触账号密码）
- Playwright sync API 绑定创建线程，因此所有页面操作通过命令队列
  交给采集线程串行执行，HTTP 线程只投递任务并等待结果
"""
import os, re, time, queue, hashlib, threading, mimetypes
from urllib.parse import urlparse, unquote

HOME = 'https://www.updream.cn'

IMG_EXT = {'.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'}
VID_EXT = {'.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'}

JS_COLLECT = r"""
() => {
  const out = [];
  const seen = new Set();
  const push = (o) => {
    if (!o.src || seen.has(o.src)) return;
    if (o.src.startsWith('data:')) return;
    seen.add(o.src); out.push(o);
  };
  document.querySelectorAll('img').forEach(el => {
    const s = el.currentSrc || el.src || '';
    push({ kind: 'img', src: s, alt: el.alt || el.title || '', w: el.naturalWidth || 0, h: el.naturalHeight || 0 });
  });
  document.querySelectorAll('video').forEach(el => {
    const s = el.currentSrc || el.src || '';
    push({ kind: 'video', src: s, poster: el.poster || '', w: el.videoWidth || 0, h: el.videoHeight || 0 });
  });
  document.querySelectorAll('[style*="background-image"]').forEach(el => {
    const m = (getComputedStyle(el).backgroundImage || '').match(/url\(["']?(.*?)["']?\)/);
    if (m) push({ kind: 'img', src: m[1], alt: '', w: 0, h: 0 });
  });
  return { url: location.href, title: document.title, items: out };
}
"""


class Collector:
    """平台采集器基类。

    子类只需覆盖下面几个类属性即可接入新平台：
      HOME            平台首页
      SRC             归档里的来源标识（如 'updream' / 'libtv'）
      FILE_PREFIX     下载文件前缀
      LABEL           界面显示名
      LOGIN_SELECTORS 自动点击登录入口的选择器（按优先级尝试）
    """

    HOME = 'https://www.updream.cn'
    SRC = 'updream'
    FILE_PREFIX = 'up_'
    LABEL = 'updream'
    JS_COLLECT = JS_COLLECT          # 页面素材提取脚本，子类可覆盖
    LOGIN_SELECTORS = [
        'text=注册 / 登录', 'text=注册/登录', 'text=登录',
        'button:has-text("登录")', 'a:has-text("登录")',
    ]

    def __init__(self, profile_dir, assets_dir, lib, lock, save_fn, new_asset_fn,
                 classify_fn, make_thumb_fn):
        self.profile = profile_dir
        self.assets_dir = assets_dir
        self.lib = lib
        self.lock = lock
        self.save = save_fn
        self.new_asset = new_asset_fn
        self.classify = classify_fn
        self.make_thumb = make_thumb_fn
        self.pw = None
        self.ctx = None
        self.page = None
        self._stop = threading.Event()
        self._thread = None
        self._runlock = threading.Lock()
        self._tasks = queue.Queue()
        self._hashes = set()
        self.running = False
        self.error = None

    # ============================================================
    #  生命周期
    # ============================================================
    def open_login(self):
        """打开浏览器并进入平台登录页，等待用户本人登录"""
        if self.running:
            return
        os.makedirs(self.profile, exist_ok=True)
        self._stop.clear()
        self.error = None
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        for _ in range(150):        # 等待浏览器就绪（最多约 30 秒）
            if self.page is not None or self.error or not self._thread.is_alive():
                break
            time.sleep(0.2)
        self.running = self.page is not None

    def _run(self):
        if not self._runlock.acquire(blocking=False):
            return                      # 已有采集线程在运行，禁止第二个消费者
        try:
            from playwright.sync_api import sync_playwright
        except Exception as e:
            self.error = '未安装 playwright: %s' % e
            self.running = False
            self._runlock.release()
            return
        try:
            with sync_playwright() as pw:
                self.pw = pw
                self.ctx = pw.chromium.launch_persistent_context(
                    user_data_dir=self.profile,
                    headless=False,
                    viewport=None,                    # 跟随窗口尺寸
                    args=['--disable-blink-features=AutomationControlled', '--no-first-run',
                          '--start-maximized', '--window-size=1440,900'],
                )
                self.ctx.on('close', lambda _: setattr(self, 'running', False))
                self.page = self.ctx.pages[0] if self.ctx.pages else self.ctx.new_page()
                try:
                    self.page.goto(self.HOME, timeout=60000, wait_until='domcontentloaded')
                    self.page.wait_for_timeout(1800)
                    self._goto_login()
                except Exception as e:
                    print('[collector] 打开首页异常:', e)
                self.page.bring_to_front()

                # 主循环：保持会话 + 串行执行页面操作队列
                while not self._stop.is_set():
                    try:
                        fn, ev, box = self._tasks.get(timeout=0.2)
                    except queue.Empty:
                        continue
                    try:
                        box['res'] = fn()
                    except Exception as e:
                        box['err'] = e
                    finally:
                        ev.set()
                try:
                    self.ctx.close()
                except Exception:
                    pass
        except Exception as e:
            self.error = '浏览器运行异常: %s' % e
            print('[collector] 运行异常:', e)
        finally:
            self.running = False
            self.page = None
            try:
                self._runlock.release()
            except RuntimeError:
                pass

    def _exec(self, fn, timeout=120):
        """把页面操作投递给采集线程执行（Playwright 线程绑定约束）"""
        if not self.running or not self.page:
            raise RuntimeError('浏览器未就绪')
        ev = threading.Event()
        box = {}
        self._tasks.put((fn, ev, box))
        if not ev.wait(timeout):
            raise RuntimeError('操作超时')
        if 'err' in box:
            raise box['err']
        return box.get('res')

    def close(self):
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=6)
        self.running = False

    # ============================================================
    #  页面操作（内部，运行于采集线程）
    # ============================================================
    def _goto_login(self):
        """自动点击登录入口，让用户直接看到登录界面"""
        for sel in self.LOGIN_SELECTORS:
            try:
                loc = self.page.locator(sel).first
                if loc.count() > 0 and loc.is_visible():
                    loc.click(timeout=3000)
                    self.page.wait_for_timeout(1200)
                    return True
            except Exception:
                continue
        return False

    def _shot_inner(self, out_path):
        self.page.bring_to_front()
        self.page.screenshot(path=out_path, full_page=False)
        return out_path

    def _capture_inner(self):
        data = self.page.evaluate(self.JS_COLLECT)
        url = data.get('url', '')
        title = data.get('title', '') or (self.LABEL + ' 页面')
        added = 0

        for it in data.get('items', []):
            src = it.get('src', '')
            if not src or src.startswith('blob:'):
                continue
            if it['kind'] == 'img' and (it.get('w') or 0) and (it.get('w') < 96 or it.get('h') < 96):
                continue  # 过滤图标
            try:
                added += self._grab(src, it.get('alt', ''), it['kind'], url, title)
            except Exception as e:
                print('[collector] 抓取失败 %s: %s' % (src[:80], e))

        # 页面快照（便于回溯画布上下文）
        try:
            shot = os.path.join(self.assets_dir, 'shot_%d.png' % int(time.time()))
            self.page.screenshot(path=shot, full_page=False)
            a = self.new_asset(kind='other', title='%s · 页面快照' % title[:40],
                               source=self.SRC, sourceUrl=url,
                               file='assets/' + os.path.basename(shot),
                               size=os.path.getsize(shot), mime='image/png',
                               note='采集器自动保存的页面快照')
            t = self.make_thumb(shot, a['id'])
            if t:
                a['thumb'] = t
            with self.lock:
                self.lib['assets'].append(a)
                self.save(self.lib)
            added += 1
        except Exception as e:
            print('[collector] 快照失败:', e)

        return added

    # ============================================================
    #  对外接口（线程安全）
    # ============================================================
    def _goto_inner(self, spec):
        """进入项目：spec={'url':...} 直接跳转；{'text':...} 点击文本匹配"""
        if spec.get('url'):
            self.page.goto(spec['url'], timeout=60000, wait_until='domcontentloaded')
        elif spec.get('text'):
            loc = self.page.locator('text=%s' % spec['text']).first
            if loc.count() == 0:
                raise RuntimeError('页面上未找到: %s' % spec['text'])
            loc.click(timeout=8000)
        else:
            raise RuntimeError('缺少 url 或 text')
        self.page.wait_for_timeout(3500)
        self.page.bring_to_front()
        return {'url': self.page.url, 'title': self.page.title()}

    def goto(self, spec):
        return self._exec(lambda: self._goto_inner(spec), timeout=90)

    def screenshot(self, out_path):
        return self._exec(lambda: self._shot_inner(out_path), timeout=30)

    def capture_current(self):
        return self._exec(self._capture_inner, timeout=180)

    def pick_style(self):
        return self._exec(self._pick_style_inner, timeout=40)

    # ============================================================
    #  设计语言提取（运行于采集线程）
    # ============================================================
    def _pick_style_inner(self):
        js = """
        () => {
          const pick = (el, props) => {
            if (!el) return null;
            const cs = getComputedStyle(el);
            const o = {sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,3).join('.') : '')};
            props.forEach(p => o[p] = cs.getPropertyValue(p));
            return o;
          };
          const P = ['background','background-color','background-image','color','font-family','font-size','font-weight','border-radius','box-shadow','border','backdrop-filter','letter-spacing'];
          const out = {body: pick(document.body, P), samples: []};
          const seen = new Set();
          const cands = document.querySelectorAll('button, a, .btn, [class*="card"], [class*="panel"], [class*="item"], [class*="nav"], [class*="header"], [class*="top"], h1, h2, h3, input, [class*="input"], [class*="modal"], [class*="tag"], [class*="badge"]');
          for (const el of cands) {
            const r = el.getBoundingClientRect();
            if (r.width < 30 || r.height < 12 || !el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
            const cs = getComputedStyle(el);
            const key = cs.backgroundColor + '|' + cs.color + '|' + cs.borderRadius + '|' + (el.className || '');
            if (seen.has(key)) continue;
            seen.add(key);
            const o = pick(el, P);
            o.rect = [Math.round(r.width), Math.round(r.height)];
            out.samples.push(o);
            if (out.samples.length >= 60) break;
          }
          // 页面主色统计
          const cols = {};
          document.querySelectorAll('*').forEach(el => {
            const c = getComputedStyle(el).color;
            if (c) cols[c] = (cols[c] || 0) + 1;
          });
          out.topColors = Object.entries(cols).sort((a,b)=>b[1]-a[1]).slice(0,12);
          return out;
        }
        """
        return self.page.evaluate(js)

    # ============================================================
    #  下载与归档（运行于采集线程）
    # ============================================================
    def _grab(self, src, alt, kind, page_url, page_title):
        if not src.startswith('http'):
            if src.startswith('//'):
                src = 'https:' + src
            else:
                src = self._abs(src, page_url)
        resp = self.page.request.get(src, timeout=45000)
        if not resp.ok:
            return 0
        body = resp.body()
        if not body or len(body) < 2048:
            return 0
        h = hashlib.md5(body).hexdigest()
        if h in self._hashes:
            return 0
        self._hashes.add(h)

        name = self._name_of(src, alt, kind)
        ext = os.path.splitext(name)[1].lower()
        if kind == 'img' and ext not in IMG_EXT:
            ext = '.png'
            name += ext
        if kind == 'video' and ext not in VID_EXT:
            ext = '.mp4'
            name += ext

        fp = os.path.join(self.assets_dir, '%s%s_%s' % (self.FILE_PREFIX, hashlib.md5(src.encode()).hexdigest()[:8], name[-60:]))
        with open(fp, 'wb') as f:
            f.write(body)

        k, view, stage = self.classify(name, alt)
        if k == 'other':
            k = 'sequence' if kind == 'video' else 'other'
        a = self.new_asset(
            kind=k, title=os.path.splitext(name)[0][:80] or (alt or page_title)[:80],
            view=view, stage=stage,
            project=page_title[:60],
            tags=[self.SRC, '采集'],
            prompt=alt[:400],
            source=self.SRC, sourceUrl=page_url,
            file='assets/' + os.path.basename(fp),
            mime=mimetypes.guess_type(fp)[0] or '',
            size=len(body), hash=h,
        )
        if kind == 'img':
            t = self.make_thumb(fp, a['id'])
            if t:
                a['thumb'] = t
        with self.lock:
            self.lib['assets'].append(a)
            self.save(self.lib)
        return 1

    @staticmethod
    def _abs(src, base):
        p = urlparse(base)
        if src.startswith('/'):
            return '%s://%s%s' % (p.scheme, p.netloc, src)
        return '%s://%s/%s' % (p.scheme, p.netloc, src.lstrip('/'))

    @staticmethod
    def _name_of(src, alt, kind):
        p = urlparse(src)
        base = os.path.basename(unquote(p.path))
        base = re.split(r'[?#]', base)[0]
        if not base or '.' not in base:
            base = (re.sub(r'[^\w\u4e00-\u9fa5]+', '_', alt)[:40] or ('video' if kind == 'video' else 'image'))
            base += '.mp4' if kind == 'video' else '.png'
        return base
