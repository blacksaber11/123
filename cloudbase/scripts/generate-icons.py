#!/usr/bin/env python3
"""代码生成小程序图标：先用 PIL 在 4 倍画布上绘制矢量线稿，再缩放出 PNG。

产物：
- cloudbase/miniprogram/assets/icons/tab-*.png        底部导航（普通 / 选中两态，81×81）
- cloudbase/miniprogram/assets/icons/entry-*.png      发布入口（96×96）
- cloudbase/miniprogram/assets/icons/fab-plus.png     发布按钮 ＋（81×81）

只依赖 Pillow，可重复执行覆盖。
"""

import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'miniprogram', 'assets', 'icons')
SCALE = 4  # 超采样倍数，边缘更干净

NORMAL = '#71717A'
ACTIVE = '#0B7A4B'
GREEN = '#0B7A4B'
ORANGE = '#E85600'
BLUE = '#2563EB'
PURPLE = '#7C3AED'
WHITE = '#FFFFFF'
LIGHT = '#D4D4D8'


def new_canvas(units=24, px=81):
    """返回画布、坐标换算函数；画布按 px*SCALE 建立，最终缩小到 px。"""
    size = px * SCALE
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    k = size / float(units)
    # 线宽按 24 网格的 1.9 单位换算，保证缩小后仍然清晰
    width = max(2, int(round(1.9 * k)))

    def p(x, y):
        return (x * k, y * k)

    return img, draw, p, width, px


def save(img, px, name):
    out = img.resize((px, px), Image.LANCZOS)
    out.save(os.path.join(OUT, name))


def stroke(draw, pts, fill, width):
    draw.line(pts, fill=fill, width=width, joint='curve')
    # 两端补圆头，避免关节处出现缺口
    r = width / 2.0
    for x, y in (pts[0], pts[-1]):
        draw.ellipse((x - r, y - r, x + r, y + r), fill=fill)


def icon_home(color, px=81):
    img, draw, p, w, _ = new_canvas(px=px)
    stroke(draw, [p(3.2, 11), p(12, 3.4), p(20.8, 11)], color, w)
    stroke(draw, [p(5.6, 9.8), p(5.6, 20.2), p(18.4, 20.2), p(18.4, 9.8)], color, w)
    stroke(draw, [p(10, 20.2), p(10, 14.4), p(14, 14.4), p(14, 20.2)], color, w)
    return img


def icon_news(color, px=81):
    img, draw, p, w, _ = new_canvas(px=px)
    x0, y0, x1, y1 = 3.8, 3.2, 20.2, 20.8
    draw.rounded_rectangle([p(x0, y0), p(x1, y1)], radius=int(2.4 * (px * SCALE / 24.0)), outline=color, width=w)
    stroke(draw, [p(8, 8.2), p(16, 8.2)], color, w)
    stroke(draw, [p(8, 12), p(16, 12)], color, w)
    stroke(draw, [p(8, 15.8), p(12.8, 15.8)], color, w)
    return img


def icon_msg(color, px=81):
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    draw.rounded_rectangle([p(3.6, 4.4), p(20.4, 16.6)], radius=int(3.6 * k), outline=color, width=w)
    stroke(draw, [p(8.4, 16.6), p(7.2, 20.4), p(12.4, 16.6)], color, w)
    r = max(2, int(0.75 * k))
    for cx in (8.8, 12, 15.2):
        cx, cy = p(cx, 10.5)
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    return img


def icon_mine(color, px=81):
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    cx, cy, r = p(12, 8.2)[0], p(12, 8.2)[1], 3.6 * k
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=w)
    box = [p(4.6, 13.2), p(19.4, 25.4)]
    draw.arc(box, start=180, end=360, fill=color, width=w)
    return img


def icon_product(color, px=96):
    """商品：立方体包装"""
    img, draw, p, w, _ = new_canvas(px=px)
    stroke(draw, [p(12, 3.2), p(20.6, 7.6), p(12, 12), p(3.4, 7.6), p(12, 3.2)], color, w)
    stroke(draw, [p(3.4, 7.6), p(3.4, 16.6), p(12, 21), p(20.6, 16.6), p(20.6, 7.6)], color, w)
    stroke(draw, [p(12, 12), p(12, 21)], color, w)
    return img


def icon_demand(color, px=96):
    """需求：清单 + 放大镜（与搜索图标区分开）"""
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    # 左侧清单
    stroke(draw, [p(3.6, 4.2), p(13.4, 4.2), p(13.4, 20.4), p(3.6, 20.4), p(3.6, 4.2)], color, w)
    stroke(draw, [p(6, 8.6), p(11, 8.6)], color, w)
    stroke(draw, [p(6, 12.2), p(11, 12.2)], color, w)
    stroke(draw, [p(6, 15.8), p(11, 15.8)], color, w)
    # 右下放大镜
    cx, cy = p(16.8, 15.6)
    r = 4.2 * k
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=w)
    stroke(draw, [p(19.9, 18.7), p(22.2, 21)], color, w)
    return img


def icon_buy(color, px=96):
    """代采：向下收入托盘"""
    img, draw, p, w, _ = new_canvas(px=px)
    stroke(draw, [p(4, 14.6), p(4, 20.4), p(20, 20.4), p(20, 14.6)], color, w)
    stroke(draw, [p(12, 3.4), p(12, 14.6)], color, w)
    stroke(draw, [p(7.8, 10.4), p(12, 14.6), p(16.2, 10.4)], color, w)
    return img


def icon_sell(color, px=96):
    """代售：从托盘向上发出"""
    img, draw, p, w, _ = new_canvas(px=px)
    stroke(draw, [p(4, 14.6), p(4, 20.4), p(20, 20.4), p(20, 14.6)], color, w)
    stroke(draw, [p(12, 20.4), p(12, 7.4)], color, w)
    stroke(draw, [p(7.8, 11.4), p(12, 7.2), p(16.2, 11.4)], color, w)
    return img


def icon_calc(color, px=96):
    """服务费试算：计算器"""
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    draw.rounded_rectangle([p(5, 3.2), p(19, 20.8)], radius=int(2.6 * k), outline=color, width=w)
    draw.rounded_rectangle([p(7.8, 6), p(16.2, 9.4)], radius=int(1 * k), outline=color, width=w)
    r = max(2, int(0.65 * k))
    for gy in (12.6, 15.8, 18.4):
        for gx in (8.4, 12, 15.6):
            cx, cy = p(gx, gy)
            draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    return img


def icon_board(color, px=96):
    """榜单：柱状图"""
    img, draw, p, w, _ = new_canvas(px=px)
    stroke(draw, [p(3.6, 20.4), p(20.4, 20.4)], color, w)
    stroke(draw, [p(6.6, 20.4), p(6.6, 13)], color, w)
    stroke(draw, [p(12, 20.4), p(12, 7.4)], color, w)
    stroke(draw, [p(17.4, 20.4), p(17.4, 10.4)], color, w)
    return img


def icon_stock(color, px=96):
    """库存：四宫格"""
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    r = int(1.8 * k)
    for x0, y0 in ((4, 4), (13, 4), (4, 13), (13, 13)):
        draw.rounded_rectangle([p(x0, y0), p(x0 + 7, y0 + 7)], radius=r, outline=color, width=w)
    return img


def icon_target(color, px=96):
    """商机：靶心"""
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    for r_units in (8.2, 4.6):
        cx, cy = p(12, 12)
        r = r_units * k
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=w)
    cx, cy = p(12, 12)
    r = 1.3 * k
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    return img


def icon_doc(color, px=96):
    """单据：委托 / 资质"""
    img, draw, p, w, _ = new_canvas(px=px)
    stroke(draw, [p(5.6, 3.2), p(14.4, 3.2), p(18.4, 7.2), p(18.4, 20.8), p(5.6, 20.8), p(5.6, 3.2)], color, w)
    stroke(draw, [p(14.4, 3.2), p(14.4, 7.2), p(18.4, 7.2)], color, w)
    stroke(draw, [p(8.4, 11.4), p(15.6, 11.4)], color, w)
    stroke(draw, [p(8.4, 14.8), p(15.6, 14.8)], color, w)
    stroke(draw, [p(8.4, 18.2), p(12.6, 18.2)], color, w)
    return img


def icon_users(color, px=96):
    """关注：双人"""
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    cx, cy = p(9.4, 8.4)
    r = 3.2 * k
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=w)
    draw.arc([p(3.4, 12.8), p(15.4, 24.4)], start=180, end=360, fill=color, width=w)
    cx, cy = p(16.6, 9.4)
    r = 2.4 * k
    draw.arc((cx - r, cy - r, cx + r, cy + r), start=200, end=340, fill=color, width=w)
    draw.arc([p(13.2, 13.6), p(21.6, 22)], start=190, end=330, fill=color, width=w)
    return img


def icon_clock(color, px=96):
    """记录：时钟"""
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    cx, cy = p(12, 12)
    r = 8.4 * k
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=w)
    stroke(draw, [p(12, 7.4), p(12, 12.4), p(15.8, 14.4)], color, w)
    return img


def icon_mail(color, px=96):
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    draw.rounded_rectangle([p(3.4, 5.4), p(20.6, 18.6)], radius=int(2.2 * k), outline=color, width=w)
    stroke(draw, [p(4.6, 7), p(12, 12.8), p(19.4, 7)], color, w)
    return img


def icon_star(color, px=96):
    img, draw, p, w, _ = new_canvas(px=px)
    import math
    cx, cy = p(12, 12)
    outer = 8.6 * px * SCALE / 24.0
    inner = 3.7 * px * SCALE / 24.0
    pts = []
    for i in range(10):
        ang = -math.pi / 2 + i * math.pi / 5
        r = outer if i % 2 == 0 else inner
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    draw.line(pts + [pts[0]], fill=color, width=w, joint='curve')
    return img


def icon_idcard(color, px=96):
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    draw.rounded_rectangle([p(3.2, 5.4), p(20.8, 18.6)], radius=int(2.2 * k), outline=color, width=w)
    cx, cy = p(8.4, 10.6)
    r = 1.9 * k
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=w)
    draw.arc([p(5.4, 12.2), p(11.4, 18.4)], start=180, end=360, fill=color, width=w)
    stroke(draw, [p(13.6, 10), p(18.4, 10)], color, w)
    stroke(draw, [p(13.6, 13.4), p(18.4, 13.4)], color, w)
    return img


def icon_gear(color, px=96):
    img, draw, p, w, _ = new_canvas(px=px)
    import math
    k = px * SCALE / 24.0
    cx, cy = p(12, 12)
    r = 4.4 * k
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=w)
    for i in range(8):
        ang = i * math.pi / 4
        c, s = math.cos(ang), math.sin(ang)
        stroke(draw, [
            (cx + 6.4 * k * c, cy + 6.4 * k * s),
            (cx + 8.8 * k * c, cy + 8.8 * k * s)
        ], color, w)
    return img


def icon_inbox(color, px=96):
    """空态：空收件托盘"""
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    draw.rounded_rectangle([p(3.4, 4.4), p(20.6, 19.6)], radius=int(2.6 * k), outline=color, width=w)
    stroke(draw, [p(3.4, 13.4), p(8.8, 13.4), p(10.4, 16), p(13.6, 16), p(15.2, 13.4), p(20.6, 13.4)], color, w)
    return img


def icon_bell(color, px=96):
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    stroke(draw, [p(5.6, 17.6), p(6.8, 16), p(6.8, 10.4)], color, w)
    draw.arc([p(6.8, 3.6), p(17.2, 14)], start=180, end=360, fill=color, width=w)
    stroke(draw, [p(17.2, 10.4), p(17.2, 16), p(18.4, 17.6)], color, w)
    stroke(draw, [p(5, 17.6), p(19, 17.6)], color, w)
    cx, cy = p(12, 20)
    r = 1.5 * k
    draw.arc((cx - r, cy - r, cx + r, cy + r), start=180, end=360, fill=color, width=w)
    return img


def icon_lock(color, px=81):
    """保密 / 私有存储：挂锁"""
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    draw.rounded_rectangle([p(5.4, 10.4), p(18.6, 20.6)], radius=int(2.2 * k), outline=color, width=w)
    draw.arc([p(8, 3.6), p(16, 12.4)], start=180, end=360, fill=color, width=w)
    stroke(draw, [p(8, 9), p(8, 11)], color, w)
    stroke(draw, [p(16, 9), p(16, 11)], color, w)
    cx, cy = p(12, 15)
    r = 1.2 * k
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    return img


def icon_megaphone(color, px=81):
    """系统通知：喇叭"""
    img, draw, p, w, _ = new_canvas(px=px)
    stroke(draw, [p(4.2, 10), p(9.4, 10), p(19.4, 5.2), p(19.4, 18.8), p(9.4, 14), p(4.2, 14), p(4.2, 10)], color, w)
    stroke(draw, [p(8.4, 14), p(10, 19.6)], color, w)
    return img


def icon_search(color, px=81):
    """搜索：放大镜"""
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    cx, cy = p(10.4, 10.4)
    r = 5.4 * k
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=w)
    stroke(draw, [p(14.6, 14.6), p(19.6, 19.6)], color, w)
    return img


def icon_plus_circle(color, px=81):
    """添加：圆圈加号"""
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    cx, cy = p(12, 12)
    r = 8.4 * k
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=w)
    stroke(draw, [p(12, 7.8), p(12, 16.2)], color, w)
    stroke(draw, [p(7.8, 12), p(16.2, 12)], color, w)
    return img


def icon_chevron_left(color, px=81):
    """返回：左箭头"""
    img, draw, p, w, _ = new_canvas(px=px)
    stroke(draw, [p(15.2, 4.8), p(8.4, 12), p(15.2, 19.2)], color, w)
    return img


def icon_info(color, px=81):
    """提示：圆圈 i"""
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    cx, cy = p(12, 12)
    r = 8.4 * k
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=w)
    stroke(draw, [p(12, 11), p(12, 16.6)], color, w)
    cx, cy = p(12, 7.8)
    r = 1.05 * k
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    return img


def icon_phone(color, px=81):
    """电话：手机外形（矩形机身 + 听筒槽 + 底部圆点），识别度最高"""
    img, draw, p, w, _ = new_canvas(px=px)
    k = px * SCALE / 24.0
    draw.rounded_rectangle([p(6.2, 2.4), p(17.8, 21.6)], radius=int(2.4 * k), outline=color, width=w)
    # 听筒槽
    stroke(draw, [p(10.2, 5.6), p(13.8, 5.6)], color, w)
    # 屏幕
    draw.rounded_rectangle([p(8.4, 8.4), p(15.6, 17.4)], radius=int(1.2 * k), outline=color, width=w)
    # 底部 home 圆点
    cx, cy = p(12, 19.6)
    r = 0.9 * k
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    return img


def icon_plus(color=WHITE, px=81):
    img, draw, p, w, _ = new_canvas(px=px)
    w2 = int(w * 1.35)
    stroke(draw, [p(12, 5.4), p(12, 18.6)], color, w2)
    stroke(draw, [p(5.4, 12), p(18.6, 12)], color, w2)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ('tab-home', icon_home, NORMAL, 81), ('tab-home-on', icon_home, ACTIVE, 81),
        ('tab-news', icon_news, NORMAL, 81), ('tab-news-on', icon_news, ACTIVE, 81),
        ('tab-msg', icon_msg, NORMAL, 81), ('tab-msg-on', icon_msg, ACTIVE, 81),
        ('tab-mine', icon_mine, NORMAL, 81), ('tab-mine-on', icon_mine, ACTIVE, 81),
        ('entry-product', icon_product, GREEN, 96),
        ('entry-demand', icon_demand, ORANGE, 96),
        ('entry-agency-buy', icon_buy, BLUE, 96),
        ('entry-agency-sell', icon_sell, PURPLE, 96),
        ('fab-plus', icon_plus, WHITE, 81),
        # 首页工具区
        ('ht-calc', icon_calc, GREEN, 96),
        ('ht-board', icon_board, GREEN, 96),
        ('ht-stock', icon_stock, GREEN, 96),
        ('ht-biz', icon_target, GREEN, 96),
        # 我的页菜单
        ('menu-pub', icon_product, GREEN, 81),
        ('menu-agency', icon_doc, GREEN, 81),
        ('menu-follow', icon_users, GREEN, 81),
        ('menu-history', icon_clock, GREEN, 81),
        ('menu-inq', icon_mail, GREEN, 81),
        ('menu-fav', icon_star, GREEN, 81),
        ('menu-qual', icon_idcard, GREEN, 81),
        ('menu-set', icon_gear, GREEN, 81),
        # 空态 / 提示插图
        ('empty-inbox', icon_inbox, LIGHT, 120),
        ('empty-target', icon_target, LIGHT, 120),
        ('empty-bell', icon_bell, LIGHT, 120),
        ('empty-mail', icon_mail, LIGHT, 120),
        ('empty-star', icon_star, LIGHT, 120),
        ('empty-users', icon_users, LIGHT, 120),
        ('empty-clock', icon_clock, LIGHT, 120),
        ('empty-doc', icon_doc, LIGHT, 120),
        ('empty-package', icon_product, LIGHT, 120),
        # 列表 / 提示用的小图标
        ('tip-bell', icon_bell, ACTIVE, 81),
        ('tip-lock', icon_lock, ACTIVE, 81),
        ('ic-lock', icon_lock, NORMAL, 81),
        ('ic-mega', icon_megaphone, ACTIVE, 81),
        # 交互小图标
        ('ic-search', icon_search, NORMAL, 81),
        ('ic-search-on', icon_search, ACTIVE, 81),
        ('ic-plus-circle', icon_plus_circle, ACTIVE, 81),
        ('ic-back', icon_chevron_left, NORMAL, 81),
        ('ic-info', icon_info, ACTIVE, 81),
        ('ic-file', icon_doc, GREEN, 81),
        ('ic-phone', icon_phone, GREEN, 81),
    ]
    for name, fn, color, px in jobs:
        save(fn(color, px=px), px, name + '.png')
        print('generated', name + '.png')


if __name__ == '__main__':
    main()
