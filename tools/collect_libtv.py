#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
LibTV（哩布哩布 AI 视频创作平台）采集器
- 复用 updream 采集器的浏览器会话与命令队列架构
- 由「用户本人」在自动化浏览器中完成登录（脚本不接触账号密码）
- LibTV 是无限画布 + 节点式工作流，素材多为 OSS 图片/视频，
  采集时读取页面已加载的 img / video / background-image
"""
import os, time

from collect_updream import Collector as BaseCollector

# LibTV 素材常见 CDN / OSS 域名（用于判断是否值得抓取）
ASSET_HOST_HINT = ('liblib', 'aliyun', 'oss', 'qiniu', 'cos.', 'myqcloud', 'cdn')

# 画布类页面里，画布节点常用 canvas / img 混用，这里额外补抓 source / poster
JS_COLLECT_LIBTV = r"""
() => {
  const out = [];
  const seen = new Set();
  const push = (o) => {
    if (!o.src || seen.has(o.src)) return;
    if (o.src.startsWith('data:') || o.src.startsWith('blob:')) return;
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
  document.querySelectorAll('video source').forEach(el => {
    const s = el.src || '';
    if (s) push({ kind: 'video', src: s, poster: '', w: 0, h: 0 });
  });
  document.querySelectorAll('[style*="background-image"]').forEach(el => {
    const m = (getComputedStyle(el).backgroundImage || '').match(/url\(["']?(.*?)["']?\)/);
    if (m) push({ kind: 'img', src: m[1], alt: '', w: 0, h: 0 });
  });
  return { url: location.href, title: document.title, items: out };
}
"""


class LibTVCollector(BaseCollector):
    HOME = 'https://www.liblib.tv/'
    SRC = 'libtv'
    FILE_PREFIX = 'libtv_'
    LABEL = 'LibTV'
    LOGIN_SELECTORS = [
        'text=登录', 'text=登录 / 注册', 'text=登录/注册',
        'button:has-text("登录")', 'a:has-text("登录")',
        '[class*="login"]', '[class*="Login"]',
        'text=立即登录', 'text=免费使用',
    ]

    # 采集时换用 LibTV 专用 JS（多抓 video source / poster）
    JS_COLLECT = JS_COLLECT_LIBTV
